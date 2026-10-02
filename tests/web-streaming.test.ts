import assert from "node:assert/strict";

import type { WebChange, WebEntry } from "../src/web-contracts.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { describe, it } from "./harness.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a page holds after applying the patches it was sent, as use-conversation does. */
function page(port: WebInteraction) {
  let entries: WebEntry[] = [];
  const kinds: string[] = [];
  let bytes = 0;
  port.subscribe((change: WebChange) => {
    const patch = change.patch;
    if (!patch) return;
    kinds.push(patch.kind);
    bytes += JSON.stringify(patch).length;
    if (patch.kind === "entry.append") entries = [...entries, { ...patch.entry }];
    else if (patch.kind === "entry.replace")
      entries = entries.map((entry) => (entry.id === patch.entry.id ? { ...patch.entry } : entry));
    else if (patch.kind === "entry.delta")
      entries = entries.map((entry) => (entry.id === patch.id ? { ...entry, text: entry.text + patch.text } : entry));
    else if (patch.kind === "entries.reset") entries = patch.entries.map((entry) => ({ ...entry }));
  });
  return {
    text: (kind: WebEntry["kind"]) => entries.find((entry) => entry.kind === kind)?.text,
    kinds,
    bytes: () => bytes,
  };
}

describe("Web streaming", () => {
  it("sends streamed text in batches of what was added, not the whole entry per token", async () => {
    const port = new WebInteraction();
    const client = page(port);
    port.setCurrentRequest("question");
    port.modelStream({ kind: "started", streamId: "s", sequence: 0 });
    const chunk = "thinking about it ";
    for (let index = 0; index < 4_000; index += 1) {
      port.modelStream({ kind: "reasoning_delta", streamId: "s", sequence: 0, text: chunk });
      if (index % 1_000 === 0) await wait(70);
    }
    port.modelStream({ kind: "text_delta", streamId: "s", sequence: 0, text: "Answer." });
    port.finalizeStreamedAnswer("Answer.");

    const thinking = chunk.repeat(4_000);
    assert.equal(client.text("thinking"), thinking);
    assert.equal(client.text("assistant"), "Answer.");
    assert.equal(port.snapshot().view.entries.find((entry) => entry.kind === "thinking")?.text, thinking);
    assert.ok(client.kinds.length < 40, String(client.kinds.length));
    assert.ok(client.bytes() < thinking.length * 2, String(client.bytes()));
    port.close();
  });

  it("redacts a secret split across tokens, replacing text the page already has", async () => {
    const port = new WebInteraction();
    const client = page(port);
    port.setCurrentRequest("question");
    port.modelStream({ kind: "started", streamId: "s", sequence: 0 });
    port.modelStream({ kind: "text_delta", streamId: "s", sequence: 0, text: "Use sk-abcdefgh" });
    await wait(70);
    assert.equal(client.text("assistant"), "Use sk-abcdefgh");
    port.modelStream({ kind: "text_delta", streamId: "s", sequence: 0, text: "ijklmnopqrstuvwxyz1234 now" });
    await wait(70);
    const shown = client.text("assistant") ?? "";
    assert.doesNotMatch(shown, /abcdefgh/u);
    assert.match(shown, /REDACTED/u);
    assert.ok(client.kinds.includes("entry.replace"));
    port.close();
  });

  it("sends pending text before the entry that follows it", () => {
    const port = new WebInteraction();
    const order: string[] = [];
    port.subscribe((change) => {
      if (change.patch?.kind === "entry.delta") order.push(`delta:${change.patch.text}`);
      if (change.patch?.kind === "entry.append") order.push(`append:${change.patch.entry.kind}`);
    });
    port.setCurrentRequest("question");
    port.modelStream({ kind: "started", streamId: "s", sequence: 0 });
    port.modelStream({ kind: "reasoning_delta", streamId: "s", sequence: 0, text: "plan" });
    port.startActivity("Reading", "tool", "read_file");
    assert.deepEqual(order, ["append:thinking", "delta:plan", "append:tool"]);
    port.close();
  });
});
