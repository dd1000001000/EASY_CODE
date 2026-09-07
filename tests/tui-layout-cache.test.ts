import assert from "node:assert/strict";
import {
  appendDisclosureViewNode,
  createDisclosureViewState,
  renderDisclosureView,
  replaceDisclosureViewNodes,
  resizeDisclosureView,
  scrollDisclosureView,
  toggleDisclosureView,
  updateDisclosureViewChrome,
} from "../src/ui/tui/disclosure-view.js";
import {
  layoutVirtualDocument,
  snapshotVirtualDocumentNodes,
  type VirtualDocumentNode,
} from "../src/ui/tui/virtual-document.js";
import { wrapToWidth } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

// Count actual Unicode layout work, not wall time (which depends on CI load).
function countSegmentation(run: (counts: { characters: number; constructors: number }) => void): void {
  const intl = Intl as unknown as {
    Segmenter: new (locale?: string, options?: { granularity: "grapheme" }) => {
      segment(value: string): Iterable<{ segment: string }>;
    };
  };
  const Original = intl.Segmenter;
  const counts = { characters: 0, constructors: 0 };
  intl.Segmenter = class {
    private readonly delegate = new Original(undefined, { granularity: "grapheme" });
    constructor() { counts.constructors += 1; }
    segment(value: string) {
      counts.characters += value.length;
      return this.delegate.segment(value);
    }
  };
  try { run(counts); } finally { intl.Segmenter = Original; }
}

function history(count = 100): VirtualDocumentNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `text-${index}`, kind: "text", text: `row ${index} 中文🙂\n`.repeat(50),
  }));
}

describe("TUI layout cache", () => {
  it("does no transcript segmentation during repeated scrolling or status ticks", () => {
    countSegmentation((counts) => {
      let state = createDisclosureViewState({
        nodes: history(), columns: 80, rows: 24,
        headerLines: ["header"], composerLines: ["Request >"], footerLines: ["status"],
      });
      renderDisclosureView(state);
      counts.characters = 0;
      for (let index = 0; index < 30; index += 1) {
        state = scrollDisclosureView(state, -1);
        state = updateDisclosureViewChrome(state, {
          headerLines: ["header"], composerLines: ["Request >"],
        });
        renderDisclosureView(state);
      }
      assert.equal(counts.characters, 0);
      for (let index = 0; index < 10; index += 1) {
        state = updateDisclosureViewChrome(state, { footerLines: [`tick ${index}`] });
        renderDisclosureView(state);
      }
      assert.ok(counts.characters < 200, `Only new footer text should be segmented: ${counts.characters}`);
      assert.equal(counts.constructors, 1);
    });
  });

  it("reuses unchanged nodes even when transcript projection recreates objects", () => {
    countSegmentation((counts) => {
      let state = createDisclosureViewState({ nodes: history(), columns: 80, rows: 24 });
      renderDisclosureView(state);
      const original = state.nodes;
      counts.characters = 0;
      state = replaceDisclosureViewNodes(state, state.nodes.map((node) => ({ ...node })));
      assert.equal(state.nodes, original);
      state = appendDisclosureViewNode(state, { id: "new", kind: "text", text: "new 中文🙂" });
      const frame = renderDisclosureView(state);
      assert.equal(state.nodes[0], original[0]);
      assert.ok(frame.rows.some((row) => row.includes("new 中文🙂")));
      assert.ok(counts.characters < 30, `Old transcript was rewrapped: ${counts.characters}`);
    });
  });

  it("invalidates changed content, width, ANSI policy and expanded body", () => {
    const input = [{ id: "a", kind: "text" as const, text: "\u001b[31m中文abcdef\u001b[0m" }];
    const snapshot = snapshotVirtualDocumentNodes(input);
    const original = layoutVirtualDocument(snapshot, 20);
    assert.equal(layoutVirtualDocument(snapshot, 20), original);
    assert.equal(layoutVirtualDocument(snapshot, 4).totalRows, 3);
    assert.ok(!layoutVirtualDocument(snapshot, 20, { preserveAnsi: false }).lines[0]?.text.includes("\u001b"));
    const next = snapshotVirtualDocumentNodes([{ ...input[0]!, text: "changed" }], snapshot);
    assert.equal(layoutVirtualDocument(next, 20).lines[0]?.text, "changed");

    let state = createDisclosureViewState({
      nodes: [{ id: "think", kind: "thinking", title: "Thinking", preview: "preview", body: "body 中文🙂", expanded: false }],
      columns: 80, rows: 12,
    });
    state = toggleDisclosureView(state, { id: "think", kind: "thinking" }, true);
    assert.ok(renderDisclosureView(state).rows.includes("body 中文🙂"));
    state = replaceDisclosureViewNodes(state, [{
      id: "think", kind: "thinking", title: "Thinking", preview: "preview", body: "new body", expanded: false,
    }]);
    assert.ok(renderDisclosureView(state).rows.includes("new body"));
    state = toggleDisclosureView(state, undefined, false);
    assert.ok(renderDisclosureView(state).rows.includes("preview"));
    assert.ok(!renderDisclosureView(state).rows.includes("new body"));
    state = resizeDisclosureView(state, 4, 12);
    assert.ok(renderDisclosureView(state).rows.includes("Thin"));
  });

  it("copies mutable input and never caches mutable public layout arguments", () => {
    const node = { id: "a", kind: "text" as const, text: "before" };
    const nodes = [node];
    const state = createDisclosureViewState({ nodes, columns: 80, rows: 12 });
    layoutVirtualDocument(nodes, 80);
    node.text = "after";
    assert.equal(layoutVirtualDocument(nodes, 80).lines[0]?.text, "after");
    assert.ok(renderDisclosureView(state).rows.includes("before"));
    assert.ok(Object.isFrozen(state.nodes));
    assert.ok(Object.isFrozen(state.nodes[0]));
    // A structurally typed state may also contain externally mutable nodes.
    const external = { ...state, nodes };
    assert.ok(renderDisclosureView(external).rows.includes("after"));
    node.text = "again";
    assert.ok(renderDisclosureView(external).rows.includes("again"));
    nodes.push({ ...node });
    assert.throws(() => renderDisclosureView(external), /Duplicate/);
  });

  it("validates node IDs without laying out text at one-column width", () => {
    countSegmentation((counts) => {
      assert.throws(() => createDisclosureViewState({
        nodes: [{ id: "", kind: "text", text: "huge body".repeat(1000) }], columns: 80, rows: 24,
      }), /cannot be empty/);
      assert.equal(counts.characters, 0);
      const nodes = history(5);
      createDisclosureViewState({ nodes, columns: 80, rows: 24 });
      const total = nodes.reduce((sum, node) => sum + (node.kind === "text" ? node.text.length : 0), 0);
      assert.equal(counts.characters, total, "Initial layout should segment each node only once");
    });
  });

  it("retains grapheme fallback when Intl.Segmenter is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    const expected = wrapToWidth("a中文👨‍👩‍👧‍👦e\u0301z", 4);
    try {
      Object.defineProperty(Intl, "Segmenter", { ...descriptor, value: undefined });
      assert.deepEqual(wrapToWidth("a中文👨‍👩‍👧‍👦e\u0301z", 4), expected);
    } finally {
      Object.defineProperty(Intl, "Segmenter", descriptor);
    }
  });
});
