import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import { SandboxedMcpStdioTransport } from "../src/mcp/sandbox-stdio.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

const ENVIRONMENT_DIRS = ["EASY_CODE_CONFIG_DIR", "EASY_CODE_DATA_DIR", "EASY_CODE_CACHE_DIR"] as const;

interface AppCloseFixture {
  app: EasyCodeApp;
  close(): void;
}

async function createAppCloseFixture(): Promise<AppCloseFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-close-app-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const previous = new Map(ENVIRONMENT_DIRS.map((name) => [name, process.env[name]] as const));
  process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
  process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
  process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
  const terminal = new Terminal(new PassThrough(), new PassThrough());
  const restore = (): void => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const app = await EasyCodeApp.create({
      workspaceRoot: workspace,
      terminal,
      // Never inspect the developer's real operating-system credentials.
      credentialStore: false,
    });
    let closed = false;
    return {
      app,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          app.close();
        } finally {
          terminal.close();
          restore();
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    terminal.close();
    restore();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

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

  it("joins concurrent app close calls into one teardown", async () => {
    const fixture = await createAppCloseFixture();
    try {
      const internal = fixture.app as unknown as { imageStore: { shutdown(): Promise<void> } };
      let shutdowns = 0;
      const original = internal.imageStore.shutdown.bind(internal.imageStore);
      internal.imageStore.shutdown = async (): Promise<void> => {
        shutdowns += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await original();
      };

      await Promise.all([fixture.app.closeAsync(), fixture.app.closeAsync()]);
      assert.equal(shutdowns, 1);
    } finally {
      fixture.close();
    }
  });

  it("reports a failed close step once and still releases every other resource", async () => {
    const fixture = await createAppCloseFixture();
    try {
      const internal = fixture.app as unknown as {
        threadLease?: unknown;
        threadStore: { releaseThreadLease(lease: unknown): void };
        storage: { db: { exec(sql: string): void } };
      };
      assert.notEqual(internal.threadLease, undefined);
      let releaseCalls = 0;
      internal.threadStore.releaseThreadLease = (): void => {
        releaseCalls += 1;
        throw new Error("simulated lease release failure");
      };

      await assert.rejects(fixture.app.closeAsync(), /simulated lease release failure/u);
      // The failed step must not stop the remaining teardown.
      assert.throws(() => internal.storage.db.exec("SELECT 1"), /SQLite database is closed/u);
      // The database is gone, so a retry could never release the lease; the app
      // stays closed and later calls do not repeat the teardown.
      await fixture.app.closeAsync();
      assert.equal(releaseCalls, 1);
    } finally {
      fixture.close();
    }
  });
});
