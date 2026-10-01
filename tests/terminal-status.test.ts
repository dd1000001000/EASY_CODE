import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import { classifyStatus, type StableStatusKind } from "../src/cli/terminal-status.js";
import type { ApprovalRequest } from "../src/core/types.js";
import type { UIProgressKind } from "../src/ui/contracts.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModeTransitions: boolean[] = [];
  private effectiveRaw = false;
  private cookedBuffer = "";

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.effectiveRaw = mode;
    this.rawModeTransitions.push(mode);
    return this;
  }

  /** Simulate ConPTY losing its OS raw flag while Node still caches isRaw. */
  loseEffectiveRawMode(): void {
    this.effectiveRaw = false;
  }

  sendFromTerminal(text: string): void {
    if (this.effectiveRaw) {
      super.write(text);
      return;
    }
    this.cookedBuffer += text;
    if (!/[\r\n]/u.test(text)) return;
    const buffered = this.cookedBuffer;
    this.cookedBuffer = "";
    super.write(buffered);
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  readonly columns = 96;
  readonly rows = 24;
}

function captureOutput(output: PassThrough): () => string {
  let transcript = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return () => transcript;
}

type AuditedStatus =
  | { readonly text: string; readonly destination: "live"; readonly kind: UIProgressKind }
  | { readonly text: string; readonly destination: "stable"; readonly kind: StableStatusKind };

const AUDITED_RUNTIME_STATUSES: readonly AuditedStatus[] = [
  {
    text: "Auto mode is choosing how to handle this request...",
    destination: "live",
    kind: "status",
  },
  {
    text: "Step 2/18: requesting deepseek-v4-pro",
    destination: "live",
    kind: "step",
  },
  { text: "Tool: read_file", destination: "live", kind: "tool" },
  {
    text: "Model response headers did not arrive within the configured interval. Retrying API attempt 2/3.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Server rejected context capacity. Historical context cleared; retrying once with user requirements. Files, budgets and execution state are unchanged.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Review review_1: reviewer is independently inspecting the workspace.",
    destination: "stable",
    kind: "info",
  },
  { text: "Runtime selected a safer fallback.", destination: "stable", kind: "info" },
  { text: "Fatal provider failure: connection lost", destination: "stable", kind: "error" },
];

function approvalRequest(): ApprovalRequest {
  return {
    id: "approval-status-test",
    title: "Run migration",
    description: "This migration modifies the workspace database.",
    risk: "workspace",
    commandPrefix: "git",
    commandPreview: "node scripts/migrate.js",
  };
}

describe("runtime status routing", () => {
  it("keeps only audited progress live and gives every notice a useful severity", () => {
    for (const status of AUDITED_RUNTIME_STATUSES) {
      assert.deepEqual(
        classifyStatus(status.text),
        { destination: status.destination, kind: status.kind },
        status.text,
      );
    }
  });

  it("prints every status in line mode and redacts credentials first", () => {
    const output = new PassThrough();
    const captured = captureOutput(output);
    const terminal = new Terminal(new PassThrough(), output);
    try {
      const liveSecret = `ghp_${"a".repeat(24)}`;
      const stableSecret = `AKIA${"B".repeat(16)}`;
      terminal.status(`Step 1/4: requesting ${liveSecret}`);
      terminal.status(
        `Model response headers did not arrive within the configured interval (${stableSecret}). Retrying API attempt 2/3.`,
      );
      const rendered = stripAnsi(captured());
      assert.match(rendered, /Step 1\/4: requesting/u);
      assert.match(rendered, /Retrying API attempt 2\/3/u);
      assert.doesNotMatch(rendered, new RegExp(liveSecret, "u"));
      assert.doesNotMatch(rendered, new RegExp(stableSecret, "u"));
      assert.match(rendered, /REDACTED/u);
    } finally {
      terminal.close();
    }
  });
});

describe("line-mode approval", () => {
  it("prints the complete request before the selector", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const captured = captureOutput(output);
    const terminal = new Terminal(input, output);
    try {
      const decision = terminal.approve(approvalRequest());
      input.write("\r");
      assert.equal(await decision, "allow_once");
      const rendered = stripAnsi(captured());
      assert.match(rendered, /Approval required: Run migration/u);
      assert.match(rendered, /This migration modifies the workspace database\./u);
      assert.match(rendered, /Command: node scripts\/migrate\.js/u);
    } finally {
      terminal.close();
    }
  });

  it("rejects without a selector on non-interactive streams", async () => {
    const output = new PassThrough();
    const captured = captureOutput(output);
    const terminal = new Terminal(new PassThrough(), output);
    try {
      assert.equal(await terminal.approve(approvalRequest()), "reject");
      assert.match(stripAnsi(captured()), /Approval required: Run migration/u);
    } finally {
      terminal.close();
    }
  });

  it("reasserts ConPTY Raw Mode before the first approval key", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const terminal = new Terminal(input, output);
    try {
      // Windows can drift back to cooked input across a focus or stdin-owner
      // transition without updating ReadStream.isRaw. Without the selector's
      // explicit reassertion, this Down key stays buffered until the first Enter.
      input.isRaw = true;
      input.loseEffectiveRawMode();
      const decision = terminal.approve(approvalRequest());
      assert.equal(input.rawModeTransitions.at(-1), true);
      input.sendFromTerminal("\u001B[B");
      input.sendFromTerminal("\r");
      assert.equal(await decision, "allow_prefix");
    } finally {
      terminal.close();
    }
  });
});
