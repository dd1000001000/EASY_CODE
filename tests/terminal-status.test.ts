import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import type { ApprovalRequest } from "../src/core/types.js";
import type {
  UIProgressKind,
  UISessionInfo,
  UIState,
  UITranscriptKind,
} from "../src/ui/contracts.js";
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

const SESSION: UISessionInfo = {
  threadId: "status-test",
  workspaceRoot: "F:\\workspace",
  mode: "auto",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinkingEffort: "medium",
};

interface InlineFixture {
  readonly input: TtyInput;
  readonly terminal: Terminal;
  readonly outputText: () => string;
  close(): void;
}

function createInlineFixture(): InlineFixture {
  const previousCi = process.env.CI;
  const previousTerm = process.env.TERM;
  process.env.CI = "";
  process.env.TERM = "xterm-256color";

  const input = new TtyInput();
  const output = new TtyOutput();
  output.setEncoding("utf8");
  let transcript = "";
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  const terminal = new Terminal(input, output);
  assert.equal(terminal.beginShell(SESSION), true);

  return {
    input,
    terminal,
    outputText: () => transcript,
    close: () => {
      terminal.close();
      restoreEnvironment("CI", previousCi);
      restoreEnvironment("TERM", previousTerm);
    },
  };
}

function restoreEnvironment(name: "CI" | "TERM", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function terminalState(terminal: Terminal): UIState {
  return (terminal as unknown as { readonly uiState: UIState }).uiState;
}

type StableKind = Extract<
  UITranscriptKind,
  "info" | "success" | "warning" | "error"
>;

type AuditedStatus =
  | { readonly text: string; readonly destination: "live"; readonly kind: UIProgressKind }
  | { readonly text: string; readonly destination: "stable"; readonly kind: StableKind };

const AUDITED_RUNTIME_STATUSES: readonly AuditedStatus[] = [
  {
    text: "Auto mode review transition: code — explicit review override",
    destination: "stable",
    kind: "info",
  },
  {
    text: "Auto mode selected code — a previous direct response failed validation",
    destination: "stable",
    kind: "info",
  },
  {
    text: "Auto mode is choosing how to handle this request...",
    destination: "live",
    kind: "status",
  },
  {
    text: "Auto mode answered directly without starting a second model request.",
    destination: "stable",
    kind: "info",
  },
  {
    text: "Context utilization returned below 60% (42%).",
    destination: "stable",
    kind: "success",
  },
  {
    text: "Context utilization is 64%; the model is advised to compact soon.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Context utilization is 76%; compact_context is required before other work.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Context utilization is 91%; Runtime is forcing a context compaction request.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Step 2/18: requesting deepseek-v4-pro",
    destination: "live",
    kind: "step",
  },
  {
    text: "Ignored tools other than memory maintenance during task-DAG finalization.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Reserved one correction step for required context compaction.",
    destination: "live",
    kind: "status",
  },
  {
    text: "The model did not compact the required context; requesting one correction.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "The child attempted to finish without submit_task_result; requesting one correction.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "The model attempted to finish with outstanding child work; requesting collection.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "The model attempted to finish while the task DAG was incomplete; continuing.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "The model did not submit its plan with propose_plan; requesting one correction.",
    destination: "stable",
    kind: "warning",
  },
  { text: "Tool: read_file", destination: "live", kind: "tool" },
  {
    text: "Context compacted through 24 messages into 1800 characters.",
    destination: "stable",
    kind: "success",
  },
  {
    text: "The model violated the required compaction protocol; requesting one correction.",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Reserved one continuation step after required context compaction.",
    destination: "live",
    kind: "status",
  },
  {
    text: "Reserved 2 finalization step(s) after memory maintenance.",
    destination: "live",
    kind: "status",
  },
  {
    text: "Reserved one final response step after the task DAG reached a terminal state.",
    destination: "live",
    kind: "status",
  },
  {
    text: "Pre-route context compaction 1/2: requesting deepseek-v4-pro",
    destination: "live",
    kind: "status",
  },
  {
    text: "Context compacted before Auto routing through 32 messages into 2100 characters.",
    destination: "stable",
    kind: "success",
  },
  {
    text: "Model usage accounting could not be saved: database unavailable",
    destination: "stable",
    kind: "warning",
  },
  {
    text: "Committed 3 long-term memory change(s).",
    destination: "stable",
    kind: "success",
  },
  {
    text: "Long-term memory maintenance was not saved: database unavailable",
    destination: "stable",
    kind: "warning",
  },
];

function approvalRequest(): ApprovalRequest {
  return {
    id: "approval-status-test",
    title: "Run migration",
    description: "This migration modifies the workspace database.",
    risk: "workspace",
    commandPrefix: "node",
    commandPreview: "node scripts/migrate.js",
  };
}

describe("Terminal runtime status routing", () => {
  it("keeps only audited progress live and commits notices with useful severity", () => {
    const fixture = createInlineFixture();
    try {
      for (const status of AUDITED_RUNTIME_STATUSES) {
        const before = terminalState(fixture.terminal);
        fixture.terminal.status(status.text);
        const after = terminalState(fixture.terminal);

        if (status.destination === "live") {
          assert.equal(after.transcript.length, before.transcript.length, status.text);
          const progress = after.live.progress.at(-1);
          assert.equal(progress?.kind, status.kind, status.text);
          assert.equal(progress?.label, status.text, status.text);
          assert.equal(progress?.status, "running", status.text);
        } else {
          assert.equal(after.transcript.length, before.transcript.length + 1, status.text);
          const entry = after.transcript.at(-1);
          assert.equal(entry?.kind, status.kind, status.text);
          assert.equal(stripAnsi(entry?.text ?? "").trim(), status.text, status.text);
        }
      }

      const beforeUnknown = terminalState(fixture.terminal).transcript.length;
      fixture.terminal.status("Runtime selected a safer fallback.");
      fixture.terminal.status("Fatal provider failure: connection lost");
      const state = terminalState(fixture.terminal);
      assert.equal(state.transcript.length, beforeUnknown + 2);
      assert.equal(state.transcript.at(-2)?.kind, "info");
      assert.equal(state.transcript.at(-1)?.kind, "error");
    } finally {
      fixture.close();
    }
  });

  it("redacts credentials before storing or rendering live and stable status text", () => {
    const fixture = createInlineFixture();
    try {
      const liveSecret = `ghp_${"a".repeat(24)}`;
      const stableSecret = `AKIA${"B".repeat(16)}`;
      fixture.terminal.status(`Step 1/4: requesting ${liveSecret}`);
      fixture.terminal.status(
        `Model usage accounting could not be saved: ${stableSecret}`,
      );
      fixture.terminal.startActivity(`Waiting for ${liveSecret}`);

      const serialized = JSON.stringify(terminalState(fixture.terminal));
      assert.doesNotMatch(serialized, new RegExp(liveSecret, "u"));
      assert.doesNotMatch(serialized, new RegExp(stableSecret, "u"));
      assert.doesNotMatch(fixture.outputText(), new RegExp(liveSecret, "u"));
      assert.doesNotMatch(fixture.outputText(), new RegExp(stableSecret, "u"));
      assert.match(serialized, /REDACTED/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps complete stable notices and tool summaries/errors outside compact live previews", () => {
    const fixture = createInlineFixture();
    try {
      const notice = `Fatal provider failure: ${"diagnostic ".repeat(40)}` +
        "STABLE-NOTICE-TAIL";
      fixture.terminal.status(notice);
      assert.match(
        stripAnsi(terminalState(fixture.terminal).transcript.at(-1)?.text ?? ""),
        /STABLE-NOTICE-TAIL/u,
      );

      const error = `first failure line\n${"detail ".repeat(80)}` +
        "TOOL-ERROR-TAIL";
      fixture.terminal.toolCompleted(
        "run_command",
        false,
        "Command failed",
        error,
      );
      const entry = stripAnsi(
        terminalState(fixture.terminal).transcript.at(-1)?.text ?? "",
      );
      assert.match(entry, /first failure line/u);
      assert.match(entry, /TOOL-ERROR-TAIL/u);

      const summary = `first summary line\n${"result ".repeat(80)}` +
        "TOOL-SUMMARY-TAIL";
      fixture.terminal.toolCompleted(
        "read_file",
        true,
        summary,
      );
      const summaryEntry = stripAnsi(
        terminalState(fixture.terminal).transcript.at(-1)?.text ?? "",
      );
      assert.match(summaryEntry, /first summary line/u);
      assert.match(summaryEntry, /TOOL-SUMMARY-TAIL/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps inline approvals modal while preserving fallback transcript output", async () => {
    const inline = createInlineFixture();
    try {
      const before = terminalState(inline.terminal).transcript.length;
      const decision = inline.terminal.approve(approvalRequest());
      const during = terminalState(inline.terminal);
      assert.equal(during.overlay?.kind, "approval");
      assert.equal(during.transcript.length, before + 1);
      assert.match(inline.outputText(), /Approval required: Run migration/u);
      assert.match(
        inline.outputText(),
        /This migration modifies the workspace database\./u,
      );
      assert.match(inline.outputText(), /Command: node scripts\/migrate\.js/u);

      inline.input.write("\r");
      assert.equal(await decision, "allow_once");
      assert.equal(terminalState(inline.terminal).overlay, null);
      assert.equal(terminalState(inline.terminal).transcript.length, before + 1);
    } finally {
      inline.close();
    }

    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    const fallback = new Terminal(input, output);
    const decision = fallback.approve(approvalRequest());
    input.write("\r");
    assert.equal(await decision, "allow_once");
    assert.match(stripAnsi(transcript), /Approval required: Run migration/u);
    assert.match(transcript, /This migration modifies the workspace database\./u);
    fallback.close();
  });

  it("hands busy input to an enhanced-key approval without leaking repeated Enter", async () => {
    const fixture = createInlineFixture();
    try {
      fixture.terminal.setCurrentRequest("Verify the updated JavaScript file");
      fixture.terminal.status("Step 2/160: requesting deepseek-v4-flash");
      fixture.terminal.status("Tool: run_command");

      const decision = fixture.terminal.approve(approvalRequest());
      assert.equal(terminalState(fixture.terminal).overlay?.kind, "approval");
      assert.equal(fixture.input.isRaw, true);

      fixture.input.write("\u001B[57353u\u001B[13u");
      assert.equal(await decision, "allow_prefix");
      assert.equal(terminalState(fixture.terminal).overlay, null);
      assert.equal(fixture.input.isRaw, true);

      // Auto-repeat after confirmation belongs to the still-busy request and
      // must never pre-submit the next composer.
      fixture.input.write("\r");
      fixture.input.write("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.terminal.clearCurrentRequest();
      assert.equal(fixture.input.isRaw, false);

      let settled = false;
      const prompt = fixture.terminal.readPrompt("> ", {
        captureImage: async () => {
          throw new Error("Image capture is not expected in this test.");
        },
      }).then((result) => {
        settled = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      fixture.input.write("fresh request\r");
      assert.equal((await prompt)?.text, "fresh request");
    } finally {
      fixture.close();
    }
  });

  it("reasserts ConPTY Raw Mode before an approval and hides the redraw-anchor cursor", async () => {
    const fixture = createInlineFixture();
    try {
      fixture.terminal.setCurrentRequest("Run the collector verification");
      assert.match(fixture.outputText(), /\u001B\[\?25l/u);

      // Windows can occasionally drift back to cooked input across a focus or
      // stdin-owner transition without updating ReadStream.isRaw. Without the
      // selector's explicit reassertion, this Down key remains buffered until
      // the first Enter and the visible choice never moves.
      fixture.input.loseEffectiveRawMode();
      const rawCallsBeforeApproval = fixture.input.rawModeTransitions.length;
      const decision = fixture.terminal.approve(approvalRequest());
      assert.equal(
        fixture.input.rawModeTransitions.length,
        rawCallsBeforeApproval + 1,
      );
      assert.equal(fixture.input.rawModeTransitions.at(-1), true);

      fixture.input.sendFromTerminal("\u001B[B");
      assert.equal(terminalState(fixture.terminal).overlay?.selectedIndex, 1);
      fixture.input.sendFromTerminal("\r");
      assert.equal(await decision, "allow_prefix");

      // Approval cleanup returns to the still-busy model/tool UI, so the
      // physical cursor must remain hidden rather than appearing beside
      // Progress as an unfocused white block.
      const afterApproval = fixture.outputText();
      assert.ok(
        afterApproval.lastIndexOf("\u001B[?25l") >
          afterApproval.lastIndexOf("\u001B[?25h"),
      );

      fixture.terminal.clearCurrentRequest();
      const afterClear = fixture.outputText();
      assert.ok(
        afterClear.lastIndexOf("\u001B[?25h") >
          afterClear.lastIndexOf("\u001B[?25l"),
      );
    } finally {
      fixture.close();
    }
  });

  it("restores busy input when the active request changes during approval", async () => {
    const fixture = createInlineFixture();
    try {
      fixture.terminal.setCurrentRequest("Original request");
      const decision = fixture.terminal.approve(approvalRequest());
      fixture.terminal.setCurrentRequest("Replacement request");

      assert.equal(await decision, "reject");
      const internals = fixture.terminal as unknown as {
        busyInputOwner?: unknown;
      };
      assert.notEqual(internals.busyInputOwner, undefined);
      assert.equal(fixture.input.isRaw, true);
      assert.match(
        terminalState(fixture.terminal).composer.placeholder,
        /Replacement request/u,
      );
    } finally {
      fixture.close();
    }
  });

  it("drops a partial busy Escape before handing input to approval", async () => {
    const fixture = createInlineFixture();
    try {
      fixture.terminal.setCurrentRequest("Request with pending input");
      fixture.input.write("\u001B");
      const decision = fixture.terminal.approve(approvalRequest());
      let settled = false;
      void decision.then(() => {
        settled = true;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      assert.equal(settled, false);
      fixture.input.write("\r");
      assert.equal(await decision, "allow_once");
    } finally {
      fixture.close();
    }
  });
});
