import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  EasyCodeApp,
  attributeSubagentCommandAudit,
} from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CommandAuditEntry,
} from "../src/core/types.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { grantCommandApprovalPrefix } from "../src/command/approval.js";
import { describe, it } from "./harness.js";

const AGENT_ID = "subagent_00000000-0000-4000-8000-000000000001";
const TASK_ID = "verify_auth";

class ApprovalProbeTerminal extends Terminal {
  approvalCalls = 0;
  infoCalls = 0;

  constructor() {
    super(new PassThrough(), new PassThrough());
  }

  override async approve(_request: ApprovalRequest): Promise<ApprovalDecision> {
    this.approvalCalls += 1;
    return "allow_once";
  }

  override info(_text: string): void {
    this.infoCalls += 1;
  }
}

function approvalRequest(): ApprovalRequest {
  return {
    id: "approval_test",
    title: "Run workspace command",
    description: "A test command requires explicit approval.",
    risk: "workspace",
    commandPrefix: process.execPath,
  };
}

function approvalHarness(
  assumeYes: boolean,
  commandApprovalPrefixes: readonly string[] = [],
): {
  terminal: ApprovalProbeTerminal;
  request(request: ApprovalRequest): Promise<boolean>;
} {
  const terminal = new ApprovalProbeTerminal();
  const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
  Object.defineProperties(app, {
    assumeYes: { value: assumeYes },
    terminal: { value: terminal },
    state: {
      value: { commandApprovalPrefixes: [...commandApprovalPrefixes] },
      writable: true,
    },
  });
  const internal = app as unknown as {
    requestSubagentApproval(
      request: ApprovalRequest,
      source: { agentId: string; taskId: string },
    ): Promise<boolean>;
  };
  return {
    terminal,
    request: (request) => internal.requestSubagentApproval(request, {
      agentId: AGENT_ID,
      taskId: TASK_ID,
    }),
  };
}

function commandAudit(): CommandAuditEntry {
  return {
    id: "command_00000000-0000-4000-8000-000000000001",
    program: "npm",
    args: ["test"],
    cwd: ".",
    status: "exited",
    exitCode: 0,
    durationMs: 25,
    timestamp: "2026-08-27T12:00:00.000Z",
    summary: "Exited with code 0",
  };
}

describe("background subagent approvals", () => {
  it("fails closed without opening or repainting the shared terminal", async () => {
    const harness = approvalHarness(false);
    try {
      assert.equal(await harness.request(approvalRequest()), false);
      assert.equal(harness.terminal.approvalCalls, 0);
      assert.equal(harness.terminal.infoCalls, 0);
    } finally {
      harness.terminal.close();
    }
  });

  it("honors --yes without opening or repainting the shared terminal", async () => {
    const harness = approvalHarness(true);
    try {
      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.approvalCalls, 0);
      assert.equal(harness.terminal.infoCalls, 0);
    } finally {
      harness.terminal.close();
    }
  });

  it("consumes an exact parent-Thread executable grant without opening stdin", async () => {
    const harness = approvalHarness(
      false,
      grantCommandApprovalPrefix([], process.execPath),
    );
    try {
      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.approvalCalls, 0);
      assert.equal(harness.terminal.infoCalls, 0);

      const different = {
        ...approvalRequest(),
        commandPrefix: path.join(path.dirname(process.execPath), "different-executable"),
      };
      assert.equal(await harness.request(different), false);
      assert.equal(harness.terminal.approvalCalls, 0);
    } finally {
      harness.terminal.close();
    }
  });

  it("adds structured child and task attribution to merged command audits", () => {
    const original = commandAudit();
    const attributed = attributeSubagentCommandAudit(original, {
      agentId: AGENT_ID,
      taskId: TASK_ID,
    });

    assert.notEqual(attributed, original);
    assert.notEqual(attributed.args, original.args);
    assert.equal(attributed.sourceAgentRole, "subagent");
    assert.equal(attributed.sourceAgentId, AGENT_ID);
    assert.equal(attributed.sourceTaskId, TASK_ID);
    assert.equal(original.sourceAgentRole, undefined);
  });

  it("preserves child command attribution through the parent journal", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-child-audit-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_child_command_audit",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const attributed = attributeSubagentCommandAudit(commandAudit(), {
        agentId: AGENT_ID,
        taskId: TASK_ID,
      });

      threads.recordToolAudit(state.threadId, "turn_collect_child", attributed);
      const recovered = threads.recover(state.threadId);
      const projected = storage.db
        .prepare<[], {
          source_agent_role: string | null;
          source_agent_id: string | null;
          source_task_id: string | null;
        }>(
          `SELECT source_agent_role, source_agent_id, source_task_id
             FROM tool_audit
            WHERE id = 'command_00000000-0000-4000-8000-000000000001'`,
        )
        .get();

      assert.equal(recovered.commands.length, 1);
      assert.equal(recovered.commands[0]?.sourceAgentRole, "subagent");
      assert.equal(recovered.commands[0]?.sourceAgentId, AGENT_ID);
      assert.equal(recovered.commands[0]?.sourceTaskId, TASK_ID);
      assert.equal(projected?.source_agent_role, "subagent");
      assert.equal(projected?.source_agent_id, AGENT_ID);
      assert.equal(projected?.source_task_id, TASK_ID);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
