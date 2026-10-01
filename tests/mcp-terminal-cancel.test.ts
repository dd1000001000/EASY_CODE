import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Terminal } from "../src/cli/terminal.js";
import { describe, it } from "./harness.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("MCP authorization terminal cancellation", () => {
  it("handles cooked-mode SIGINT while an authorization is pending", async () => {
    const terminal = new Terminal(new PassThrough(), new PassThrough());
    try {
      const before = process.listenerCount("SIGINT");
      const pending = terminal.withCancellableExternalOperation(waitForAbort);
      process.emit("SIGINT");
      await assert.rejects(pending, /canceled by user/u);
      assert.equal(process.listenerCount("SIGINT"), before);
    } finally {
      terminal.close();
    }
  });
});
