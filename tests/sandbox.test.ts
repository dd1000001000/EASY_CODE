import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CommandPolicy, CommandRuntime } from "../src/command/index.js";
import type { CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  AnthropicSandboxBackend,
  encodeSandboxControl,
  extractSandboxControls,
  type CommandExecutionBackend,
  type PreparedCommand,
  type SandboxExecutionMetadata,
  type SandboxExecutionRequest,
  type SandboxWorkerPayload,
} from "../src/sandbox/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

async function withWorkspace(
  run: (root: string, manager: WorkspaceManager) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), ".easy-code-sandbox-test-"));
  try {
    const manager = await WorkspaceManager.create(root);
    await run(root, manager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(
  root: string,
  options: { audit?: CommandAuditEntry[] } = {},
): ToolContext {
  return {
    workspaceRoot: root,
    mode: "code",
    threadId: "thread-sandbox-test",
    turnId: "turn-sandbox-test",
    approvalPolicy: "safe",
    requestApproval: async () => true,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
    recordCommand: (entry) => options.audit?.push(entry),
  };
}

function sandboxRequest(root: string): SandboxExecutionRequest {
  return {
    commandId: "command-sandbox-payload",
    commandPreview: "structured command preview",
    command: {
      program: "node",
      executablePath: process.execPath,
      args: ["fixture.cjs", "argument with spaces", "literal;&|value"],
      cwdAbsolute: root,
      cwdRelative: ".",
      executableInsideWorkspace: false,
      environment: {
        PATH: process.env.PATH,
        EASY_CODE_TEST_ENV: "preserved-value",
      },
      environmentKeys: ["EASY_CODE_TEST_ENV", "PATH"],
    },
    policyDecision: {
      id: "policy-sandbox-payload",
      effect: "allow",
      capability: "safe_inspect",
      risk: "read",
      reason: "Focused sandbox preparation test",
      matchedRule: "test.sandbox_prepare",
    },
    context: toolContext(root),
  };
}

class ThrowingSandboxBackend implements CommandExecutionBackend {
  prepareCalls = 0;
  lastRequest?: SandboxExecutionRequest;

  describe(): SandboxExecutionMetadata {
    return {
      backend: "host-test-only",
      enforced: false,
      filesystem: "host",
      network: "host",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    this.prepareCalls += 1;
    this.lastRequest = request;
    throw new Error("focused backend preparation failure");
  }
}

describe("sandbox command execution boundary", () => {
  it("encodes, extracts, and scopes sandbox worker control markers", () => {
    const commandId = "command-owned";
    const owned = encodeSandboxControl(commandId, {
      type: "ready",
      backend: "anthropic-srt-linux",
    });
    const foreign = encodeSandboxControl("command-foreign", {
      type: "sandbox_error",
      message: "belongs to another command",
    });
    const originalText = `before\n${owned}middle\n${foreign}after`;

    assert.doesNotMatch(owned, /"type"|anthropic-srt-linux/u);
    const extracted = extractSandboxControls(commandId, {
      head: `before\n${owned}middle\n`,
      tail: `${foreign}after`,
      text: originalText,
      totalBytes: Buffer.byteLength(originalText),
      truncated: false,
    });

    assert.deepEqual(extracted.controls, [
      { type: "ready", backend: "anthropic-srt-linux" },
    ]);
    assert.equal(extracted.digest.text, `before\nmiddle\n${foreign}after`);
    assert.equal(extracted.digest.head, "before\nmiddle\n");
    assert.equal(extracted.digest.tail, `${foreign}after`);
    assert.equal(extracted.digest.truncated, false);
  });

  it("prepares a structured worker payload and removes its scratch data", async () => {
    await withWorkspace(async (root, manager) => {
      const backend = new AnthropicSandboxBackend(manager, {
        sensitiveReadPaths: [path.join(root, "private-fixture")],
      });
      const request = sandboxRequest(root);
      const prepared = await backend.prepare(request);
      const payloadPath = prepared.args[1];
      assert.ok(payloadPath, "sandbox worker payload path was not provided");

      try {
        assert.equal(prepared.executablePath, process.execPath);
        assert.equal(prepared.args.length, 2);
        assert.equal(prepared.cwdAbsolute, root);
        assert.equal(prepared.environment.EASY_CODE_TEST_ENV, "preserved-value");
        assert.equal(prepared.environment.EASY_CODE_SRT_WORKER, "1");

        const payload = JSON.parse(
          await readFile(payloadPath, "utf8"),
        ) as SandboxWorkerPayload;
        assert.equal(payload.version, 1);
        assert.equal(payload.commandId, request.commandId);
        assert.equal(payload.commandPreview, request.commandPreview);
        assert.equal(payload.workspaceRoot, root);
        assert.equal(payload.target.executablePath, process.execPath);
        assert.deepEqual(payload.target.args, request.command.args);
        assert.equal(payload.target.cwdAbsolute, root);
        assert.equal(payload.target.environment.EASY_CODE_TEST_ENV, "preserved-value");
        assert.equal(payload.target.environment.EASY_CODE_SANDBOXED, "1");
        assert.equal(payload.target.environment.HOME, path.join(payload.scratchRoot, "home"));
        assert.deepEqual(payload.network.allowedDomains, []);
        assert.equal(payload.filesystem.allowWrite.includes(root), true);
        assert.equal(
          payload.filesystem.denyRead.includes(path.resolve(root, "private-fixture")),
          true,
        );
        assert.equal(
          payload.filesystem.denyRead.includes(path.dirname(payload.scratchRoot)),
          true,
        );
        assert.equal(payload.filesystem.denyRead.includes(payloadPath), true);
      } finally {
        await prepared.cleanup();
        await prepared.cleanup();
      }

      await assert.rejects(
        access(payloadPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  });

  it("fails closed when backend preparation fails and never starts the target", async () => {
    await withWorkspace(async (root, manager) => {
      const markerPath = path.join(root, "target-started.txt");
      await writeFile(
        path.join(root, "would-start.cjs"),
        "require('node:fs').writeFileSync('target-started.txt', 'started');\n",
        "utf8",
      );
      await manager.refreshManifest();

      const backend = new ThrowingSandboxBackend();
      const audit: CommandAuditEntry[] = [];
      const runtime = new CommandRuntime(manager, new CommandPolicy(), backend);
      const output = await runtime.run(
        {
          program: "node",
          args: ["would-start.cjs"],
          intent: "run",
          reason: "The fake target would leave a marker if it were launched",
        },
        toolContext(root, { audit }),
      );

      assert.equal(backend.prepareCalls, 1);
      assert.equal(backend.lastRequest?.command.args[0], "would-start.cjs");
      assert.equal(output.status, "sandbox_unavailable");
      assert.equal(output.exitCode, null);
      assert.match(output.stderr.text, /sandbox unavailable/iu);
      assert.match(output.stderr.text, /focused backend preparation failure/u);
      assert.deepEqual(output.workspaceDelta, {
        created: [],
        updated: [],
        deleted: [],
        truncated: false,
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.status, "sandbox_unavailable");
      await assert.rejects(
        access(markerPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  });
});
