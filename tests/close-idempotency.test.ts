import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SandboxedMcpStdioTransport } from "../src/mcp/sandbox-stdio.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

describe("close idempotency", () => {
  it("joins concurrent transport close calls into one teardown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-close-transport-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-close-data-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const transport = new SandboxedMcpStdioTransport(
        workspace,
        { transport: "stdio", command: "node", args: [], cwd: ".", env: {}, enabled: false },
        data,
      );
      const events: string[] = [];
      let releaseExecution: (outcome: { confirmed: true; exitCode: number }) => void = () => undefined;
      const execution = new Promise<{ confirmed: true; exitCode: number }>((resolve) => {
        releaseExecution = resolve;
      });
      let releaseService: () => void = () => undefined;
      const internals = transport as unknown as {
        active: boolean;
        service: { request: () => Promise<unknown>; close: () => Promise<void> };
        execution: Promise<{ confirmed: true; exitCode: number }>;
      };
      internals.active = true;
      internals.service = {
        request: async () => undefined,
        close: () =>
          new Promise<void>((resolve) => {
            releaseService = resolve;
          }),
      };
      internals.execution = execution;
      transport.onclose = () => events.push("onclose");
      transport.onDisconnected = () => events.push("onDisconnected");

      const first = transport.close();
      const second = transport.close();
      assert.equal(second, first);
      assert.equal(transport.isActive, false);

      releaseExecution({ confirmed: true, exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The shared teardown is still waiting on the sandbox service; a joined
      // second caller must not have reported completion before this point.
      assert.deepEqual(events, []);
      releaseService();
      await first;
      assert.deepEqual(events, ["onclose", "onDisconnected"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});
