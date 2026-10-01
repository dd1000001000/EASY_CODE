import assert from "node:assert/strict";

import { formatAssistantText, formatToolTranscript, toolTarget } from "../src/cli/transcript-format.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

describe("transcript formatting", () => {
  it("marks an answer with a bullet and keeps later rows under its text", () => {
    assert.equal(formatAssistantText("First line\n\n- item", false), "● First line\n\n  - item");
    assert.match(formatAssistantText("Hi", true), /^\u001B\[36m●\u001B\[39m Hi$/u);
  });

  it("renders a tool call with its target and the complete result under ⎿", () => {
    assert.equal(
      formatToolTranscript({
        name: "read_file",
        ok: true,
        target: "src/index.ts",
        summary: "Read 120 lines.\nTruncated at line 120.",
        color: false,
      }),
      "● read_file(src/index.ts)\n  ⎿  Read 120 lines.\n     Truncated at line 120.",
    );
    assert.equal(formatToolTranscript({ name: "name_thread", ok: true, color: false }), "● name_thread");
  });

  it("shows a failure in red with its error, and drops the error on success", () => {
    const failed = formatToolTranscript({
      name: "run_command",
      ok: false,
      target: "npm test",
      summary: "Exit code 1.",
      error: "1 test failed",
      color: true,
    });
    assert.match(failed, /^\u001B\[31m●/u);
    assert.match(failed, /\u001B\[31m1 test failed/u);
    assert.equal(stripAnsi(failed), "● run_command(npm test)\n  ⎿  Exit code 1.\n     1 test failed");
    assert.equal(
      formatToolTranscript({ name: "run_command", ok: true, error: "stale", color: false }),
      "● run_command",
    );
  });

  it("joins display details into one single-line target", () => {
    assert.equal(toolTarget(undefined), undefined);
    assert.equal(toolTarget([]), undefined);
    assert.equal(
      toolTarget([
        { label: "Action", value: "complete" },
        { label: "Tasks", value: "Inspect\nbackend" },
      ]),
      "complete · Inspect backend",
    );
  });
});
