import assert from "node:assert/strict";

import {
  ReasoningRegistry,
  prepareReasoningText,
  renderReasoningBody,
  renderReasoningMarker,
} from "../src/cli/reasoning.js";
import { describe, it } from "./harness.js";

describe("Thinking terminal presentation", () => {
  it("renders the stable marker, a gray preview, and a gray expanded body", () => {
    const registry = new ReasoningRegistry();
    const block = registry.add("Inspect the repository before editing.");

    assert.equal(
      renderReasoningMarker(block),
      "▶ Thinking #1 · 38 chars · /thinking 1 · VS Code Ctrl/Cmd+click to toggle\n" +
        "  Inspect the repository before editing.\n",
    );
    assert.match(renderReasoningMarker(block, { color: true }), /\u001b\[90m/u);
    assert.equal(
      renderReasoningBody(block),
      "\n▼ Thinking #1\nInspect the repository before editing.\n▲ End Thinking #1\n",
    );
  });

  it("flattens and truncates the automatic preview with three dots", () => {
    const registry = new ReasoningRegistry();
    const block = registry.add("First line\nsecond   line with more detail");

    assert.equal(
      renderReasoningMarker(block, { previewChars: 19 }),
      `▶ Thinking #1 · ${block.sourceChars} chars · ` +
        `/thinking 1 · VS Code Ctrl/Cmd+click to toggle\n` +
        "  First line second l...\n",
    );
  });

  it("strips terminal controls before redacting secrets", () => {
    const unsafe = [
      "\u001B]0;forged title\u0007safe",
      "api\u001B[31m_key\u001B[0m=super-secret-value",
      "api\u200B_key=another-secret-value",
      "ghp_12345678901234567890",
      "direction:\u202Etxt.exe",
    ].join("\n");
    const prepared = prepareReasoningText(unsafe);

    assert.doesNotMatch(
      prepared.text,
      /\u001B|\u200B|\u202E|super-secret-value|another-secret-value|ghp_/u,
    );
    assert.match(prepared.text, /\[REDACTED\]/u);
    assert.match(prepared.text, /direction:txt\.exe/u);

    const preview = renderReasoningMarker(new ReasoningRegistry().add(unsafe));
    assert.doesNotMatch(
      preview,
      /\u001B\]|\u200B|\u202E|super-secret-value|another-secret-value|ghp_/u,
    );
    assert.match(preview, /\[REDACTED\]/u);
  });

  it("bounds long content and keeps IDs monotonic after a thread clear", () => {
    const registry = new ReasoningRegistry({
      maxChars: 40,
      maxLines: 2,
      maxLineChars: 20,
    });
    const first = registry.add(`${"a".repeat(30)}\nsecond\nthird`);
    assert.equal(first.truncated, true);
    assert.ok(Array.from(first.text).length <= 41);
    assert.equal(registry.get("last")?.id, first.id);

    registry.clear();
    assert.equal(registry.get("last"), undefined);
    assert.equal(registry.get(first.id), undefined);
    const second = registry.add("new thread");
    assert.equal(second.id, first.id + 1);
  });

  it("retains complete sanitized Thinking by default without a hidden registry cap", () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `reasoning row ${index + 1}: ${"x".repeat(80)}`,
    ).join("\n");
    const registry = new ReasoningRegistry();
    const first = registry.add(source);
    assert.equal(first.truncated, false);
    assert.equal(first.text, source);
    assert.match(renderReasoningBody(first), /reasoning row 300:/u);

    for (let index = 0; index < 300; index += 1) {
      registry.add(`later block ${index + 1}`);
    }
    assert.equal(registry.get(first.id)?.text, source);
  });
});
