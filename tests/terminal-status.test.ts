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

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
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

  it("keeps inline approvals modal while preserving fallback transcript output", async () => {
    const inline = createInlineFixture();
    try {
      const before = terminalState(inline.terminal).transcript.length;
      const decision = inline.terminal.approve(approvalRequest());
      const during = terminalState(inline.terminal);
      assert.equal(during.overlay?.kind, "approval");
      assert.equal(during.transcript.length, before);
      assert.doesNotMatch(inline.outputText(), /Approval required: Run migration/u);

      inline.input.write("\r");
      assert.equal(await decision, "allow_once");
      assert.equal(terminalState(inline.terminal).overlay, null);
      assert.equal(terminalState(inline.terminal).transcript.length, before);
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
});
