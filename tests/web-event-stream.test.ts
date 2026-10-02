import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { EasyCodeApp } from "../src/app.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { EasyCodeWebServer } from "../src/web-server/server.js";
import { describe, it } from "./harness.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await wait(20);
  }
}

/** A hosted conversation with just what opening the page and its event stream use. */
async function serve(run: (origin: string, host: WebInteraction, service: EasyCodeWebServer) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-events-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>test</title>");
  const host = new WebInteraction();
  const app = {
    dataDirectory: () => directory,
    sessionInfo: () => ({ workspaceRoot: directory, threadId: "thread_test" }),
    closeAsync: async () => {},
    startHostedSession() {},
    cancelActiveRequest: () => false,
    threadEvents: () => [],
    pendingPlan: () => undefined,
  } as unknown as EasyCodeApp;
  const service = new EasyCodeWebServer(app, host, directory, directory);
  try {
    await run(await service.start(false), host, service);
  } finally {
    await service.stop().catch(() => undefined);
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Open /api/events; `read: false` never consumes the body, like a page that stopped reading. */
function openEvents(origin: string, service: EasyCodeWebServer, read: boolean) {
  const cookie = (service as unknown as { cookie: string }).cookie;
  const events: string[] = [];
  let closed = false;
  let buffered = "";
  const request = http.get(`${origin}/api/events`, { headers: { Cookie: `easy_code_web=${cookie}` } }, (response) => {
    response.on("close", () => (closed = true));
    response.on("error", () => (closed = true));
    if (!read) {
      response.pause();
      return;
    }
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const name = /^event: (\S+)/mu.exec(buffered.slice(0, end))?.[1];
        if (name) events.push(name);
        buffered = buffered.slice(end + 2);
      }
    });
  });
  request.on("error", () => (closed = true));
  return { events, closed: () => closed, close: () => request.destroy() };
}

const streamsOf = (service: EasyCodeWebServer) => (service as unknown as { streams: Set<http.ServerResponse> }).streams;

describe("Web event stream", () => {
  it("disconnects a page that stops reading instead of buffering its events without limit", async () =>
    serve(async (origin, host, service) => {
      const stalled = openEvents(origin, service, false);
      await until(() => streamsOf(service).size === 1);
      const [stalledResponse] = [...streamsOf(service)];
      const live = openEvents(origin, service, true);
      await until(() => streamsOf(service).size === 2 && live.events.includes("snapshot"));
      const block = "x".repeat(512 * 1024);
      for (let index = 0; index < 96 && streamsOf(service).size === 2; index += 1) {
        host.info(block);
        await wait(5);
      }
      await until(() => streamsOf(service).size === 1);
      // A paused client only notices once it reads again; the server has already let go of its events.
      assert.equal(stalledResponse?.destroyed, true);
      assert.equal(streamsOf(service).has(stalledResponse!), false);
      // The page that keeps reading stays connected and receives every event.
      assert.equal(live.closed(), false);
      host.info("after");
      await until(() => live.events.filter((name) => name === "patch").length >= 2);
      live.close();
      stalled.close();
    }));

  it("sends running status only when it changes", async () =>
    serve(async (origin, host, service) => {
      const page = openEvents(origin, service, true);
      await until(() => page.events.includes("snapshot"));
      for (let index = 0; index < 5; index += 1) host.info(`notice ${index}`);
      host.setCurrentRequest("question");
      host.info("working");
      host.clearCurrentRequest();
      host.info("done");
      await until(() => page.events.filter((name) => name === "patch").length >= 9);
      // Idle was already announced when the conversation opened; busy and idle again are the two changes.
      assert.equal(page.events.filter((name) => name === "status").length, 2);
      page.close();
    }));
});
