import assert from "node:assert/strict";
import { nextTick, ref } from "vue";

import type { UISessionInfo } from "../src/ui/contracts.js";
import { formatDuration } from "../src/ui/duration.js";
import type { WebEntry } from "../src/web-contracts.js";
import { groupConversationTurns, toolTarget } from "../src/web/display-content.js";
import { setLanguage } from "../src/web/i18n.js";
import { approvalLabel, contextUsage, modeLabel, modelLabel } from "../src/web/session-labels.js";
import { useComposerHistory } from "../src/web/use-composer-history.js";
import { describe, it } from "./harness.js";

const session = (patch: Partial<UISessionInfo> = {}): UISessionInfo => ({
  threadId: "thread_1",
  workspaceRoot: "/repo",
  mode: "code",
  provider: "deepseek",
  model: "deepseek-v4",
  thinkingEffort: "medium",
  ...patch,
});

/** Just enough of a page for i18n's `document.documentElement.lang`. */
function withDocument(run: () => void): void {
  const global = globalThis as Record<string, unknown>;
  const saved = global.document;
  global.document = { documentElement: { lang: "" } };
  try {
    run();
  } finally {
    global.document = saved;
  }
}

describe("web front-end helpers", () => {
  it("shows a tool's target instead of its result text", () => {
    const tool: WebEntry = {
      id: "t",
      kind: "tool",
      text: "✓ run_command — completed",
      toolName: "run_command",
      toolDetails: [
        { label: "Command", value: "npm   test\n -- login" },
        { label: "Other", value: "x" },
      ],
      timestamp: 0,
    };
    assert.equal(toolTarget(tool), "npm test -- login");
    assert.equal(toolTarget({ ...tool, toolDetails: [{ label: "Empty", value: " " }] }), "");
    assert.equal(toolTarget({ ...tool, toolDetails: undefined }), "");
  });

  it("carries a finished turn's summary into its display", () => {
    const summary = { durationMs: 5_000, inputTokens: 10, outputTokens: 2, changedFiles: [] };
    const turns = groupConversationTurns([
      { id: "u", kind: "user", text: "Fix", turnId: "t1", turnStartedAt: 1, timestamp: 1 },
      {
        id: "a",
        kind: "assistant",
        text: "Done",
        turnId: "t1",
        answerState: "confirmed",
        turnCompletedAt: 6,
        turnSummary: summary,
        timestamp: 2,
      },
      { id: "u2", kind: "user", text: "Next", turnId: "t2", timestamp: 3 },
    ]);
    assert.deepEqual(turns[0]?.summary, summary);
    assert.equal(turns[1]?.summary, undefined);
  });

  it("formats durations with Chinese units for the Chinese page", () => {
    assert.equal(formatDuration(8_400, "zh_cn"), "8秒");
    assert.equal(formatDuration(72_400, "zh_cn"), "1分12秒");
    assert.equal(formatDuration(3_780_000, "zh_cn"), "1小时03分");
    assert.equal(formatDuration(72_400, "en_us"), "1m 12s");
  });

  it("labels the session and its context use", () => {
    withDocument(() => {
      setLanguage("en_us");
      assert.equal(modelLabel(session()), "deepseek/deepseek-v4 · Medium");
      assert.equal(modelLabel(null), "Model");
      assert.equal(modeLabel(session({ mode: "plan" })), "Plan");
      assert.equal(approvalLabel(session({ commandExecutionMode: "unrestricted" })), "Full access");
      assert.equal(contextUsage(session()), undefined);
      assert.deepEqual(contextUsage(session({ contextTokens: 48_213 })), { label: "48.2k" });
      assert.deepEqual(contextUsage(session({ contextTokens: 64_000, contextLimitTokens: 128_000 })), {
        label: "64k / 128k",
        ratio: 0.5,
      });
    });
  });

  it("walks sent messages with ↑/↓ and gives the draft back", async () => {
    const draft = ref("half-written");
    const sent = ["first", "second", "third"];
    const history = useComposerHistory(() => sent, draft);
    assert.equal(history.newer(), false);
    assert.equal(history.older(), true);
    assert.equal(draft.value, "third");
    assert.equal(history.label.value, "1/3");
    history.older();
    history.older();
    assert.equal(draft.value, "first");
    assert.equal(history.older(), false);
    history.newer();
    assert.equal(draft.value, "second");
    history.newer();
    history.newer();
    assert.equal(draft.value, "half-written");
    assert.equal(history.label.value, undefined);

    // Editing a recalled message leaves history; Escape restores the draft otherwise.
    history.older();
    draft.value = "third, edited";
    await nextTick();
    assert.equal(history.position.value, undefined);
    assert.equal(history.exit(), false);
    history.older();
    assert.equal(history.exit(), true);
    assert.equal(draft.value, "third, edited");
  });
});
