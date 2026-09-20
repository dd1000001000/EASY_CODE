import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EasyCodeApp } from "../src/app.js";
import type { ApprovalRequest, EventRecord } from "../src/core/types.js";
import { projectWebHistory } from "../src/web-server/history.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { EasyCodeWebServer } from "../src/web-server/server.js";
import { describe, it } from "./harness.js";

function event(sequence: number, type: EventRecord["type"], payload: unknown): EventRecord {
  return { schemaVersion: 1, eventId: `event_${sequence}`, threadId: "thread_test", sequence,
    timestamp: "2026-09-20T00:00:00.000Z", type, payload };
}

describe("Web conversation projection", () => {
  it("keeps user, reasoning, answer, and tool evidence in event order", () => {
    const entries = projectWebHistory([
      event(1, "message.user", { message: { role: "user", content: "Fix the issue" } }),
      event(2, "message.assistant", { role: "assistant", reasoning_content: "Investigate first", content: "I will inspect." }),
      event(3, "tool.call", { function: { name: "read_file" } }),
      event(4, "tool.result", { tool: "read_file", message: { content: "file contents" } }),
      event(5, "message.assistant", { role: "assistant", reasoning_content: "Now fix", content: "Done." }),
    ]);
    assert.deepEqual(entries.map(entry => entry.kind), ["user", "thinking", "assistant", "tool", "tool", "thinking", "assistant"]);
    assert.equal(entries.at(-1)?.text, "Done.");
    assert.equal(entries[1]?.text, "Investigate first");
    assert.ok(!entries.some(entry => entry.text.includes("file contents")));
  });
});

describe("Web interaction host", () => {
  it("reconciles streamed content without duplicate final answers", () => {
    const host = new WebInteraction();
    host.modelStream({ kind: "started", streamId: "one", sequence: 0 });
    host.modelStream({ kind: "reasoning_delta", streamId: "one", sequence: 1, text: "think" });
    host.modelStream({ kind: "text_delta", streamId: "one", sequence: 2, text: "partial" });
    host.addReasoning("complete thought");
    host.finalizeStreamedAnswer("complete answer");
    assert.deepEqual(host.snapshot().view.entries.map(item => [item.kind, item.text]), [
      ["thinking", "complete thought"], ["assistant", "complete answer"],
    ]);
    host.close();
  });

  it("offers only valid approval choices and rejects a canceled decision", async () => {
    const host = new WebInteraction();
    const approval: ApprovalRequest = { id: "approval_1", title: "Run tool", description: "Read a file",
      risk: "read", commandPrefix: "once:v1:read" };
    const decision = host.approve(approval);
    const pending = host.snapshot().view.decision;
    assert.equal(pending?.kind, "approval");
    assert.equal(pending?.choices?.some(choice => choice.id === "allow_prefix"), false);
    assert.equal(host.resolveDecision(pending!.id, "allow_prefix"), false);
    assert.equal(host.resolveDecision(pending!.id, undefined), true);
    assert.equal(await decision, "reject");
    host.close();
  });
});

describe("loopback Web service", () => {
  it("requires the local bootstrap token and cookie for session APIs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-test-"));
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>test</title>");
    const host = new WebInteraction();
    const imageId = "image_12345678-1234-4123-8123-123456789abc";
    let discarded = 0;
    const app = {
      startHostedSession() {},
      cancelActiveRequest: () => false,
      threadEvents: () => [],
      workspaceThreads: () => [],
      pendingPlan: () => undefined,
      nextHostedImageLabel: () => "Image #1",
      importHostedImage: async () => ({ id: imageId, label: "Image #1", mediaType: "image/png",
        storageKey: `attachments/${"a".repeat(32)}/${imageId}.png`, sha256: "0".repeat(64),
        byteSize: 4, width: 1, height: 1 }),
      discardHostedImage: async () => { discarded += 1; },
    } as unknown as EasyCodeApp;
    const service = new EasyCodeWebServer(app, host, directory);
    try {
      const origin = await service.start(false);
      assert.equal((await fetch(origin)).status, 200);
      assert.equal((await fetch(`${origin}/api/state`)).status, 401);
      const wrongOrigin = await fetch(`${origin}/api/bootstrap`, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: "https://example.com",
      }, body: JSON.stringify({ token: "not-the-token" }) });
      assert.equal(wrongOrigin.status, 403);
      const token = (service as unknown as { token: string }).token;
      const authenticated = await fetch(`${origin}/api/bootstrap`, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin,
      }, body: JSON.stringify({ token }) });
      assert.equal(authenticated.status, 200);
      const cookie = authenticated.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).status, 200);
      assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: "easy_code_web=wrong" } })).status, 401);
      const uploaded = await fetch(`${origin}/api/image`, { method: "POST", headers: {
        Cookie: cookie!, Origin: origin, "Content-Type": "image/png",
      }, body: Buffer.from([1, 2, 3, 4]) });
      assert.equal(uploaded.status, 200);
      const discardedResponse = await fetch(`${origin}/api/image/discard`, { method: "POST", headers: {
        Cookie: cookie!, Origin: origin, "Content-Type": "application/json",
      }, body: JSON.stringify({ id: imageId }) });
      assert.equal(discardedResponse.status, 200);
      assert.deepEqual(await discardedResponse.json(), { discarded: true });
      assert.equal(discarded, 1);
    } finally {
      await service.stop();
      host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
