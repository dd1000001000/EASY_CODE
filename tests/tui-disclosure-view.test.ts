import assert from "node:assert/strict";

import {
  appendDisclosureViewNode,
  createDisclosureViewState,
  renderDisclosureView,
  resizeDisclosureView,
  scrollDisclosureView,
  scrollDisclosureViewToEnd,
  toggleDisclosureView,
  updateDisclosureViewChrome,
  type VirtualDocumentNode,
} from "../src/ui/tui/index.js";
import { describe, it } from "./harness.js";

function fixture(body: string): readonly VirtualDocumentNode[] {
  return [
    { id: "before", kind: "text", text: "answer before" },
    {
      id: "old-thinking",
      kind: "thinking",
      title: "Thinking #1",
      preview: "old preview",
      body: "old full body that must remain closed",
      expanded: true,
    },
    {
      id: "target",
      kind: "adjustment",
      title: "Adjustment #2",
      preview: "requested change preview",
      body,
      expanded: false,
    },
    { id: "after", kind: "text", text: "answer after" },
  ];
}

describe("disclosure virtual full-screen view", () => {
  it("renders a fixed frame with click metadata and expands only the target", () => {
    const state = createDisclosureViewState({
      nodes: fixture("complete line one\ncomplete line two"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 10,
      headerLines: ["EASY CODE"],
      composerLines: ["Request >"],
      footerLines: ["auto model"],
      anchorScreenRow: 4,
    });
    const frame = renderDisclosureView(state);

    assert.equal(frame.rows.length, 10);
    assert.equal(frame.visibleRows.length, 10);
    assert.equal(frame.viewport.targetTitleScreenRow, 4);
    assert.equal(
      frame.visibleRows.find((row) => row.targetTitle)?.nodeId,
      "target",
    );
    assert.ok(frame.viewport.lines.some(
      (line) => line.nodeId === "target" && line.part === "body",
    ));
    assert.equal(frame.viewport.lines.some(
      (line) => line.nodeId === "target" && line.part === "preview",
    ), false);
    assert.ok(frame.viewport.lines.some(
      (line) => line.nodeId === "old-thinking" && line.part === "preview",
    ));
    assert.equal(frame.viewport.lines.some(
      (line) => line.nodeId === "old-thinking" && line.part === "body",
    ), false);
  });

  it("keeps all 1000 body rows reachable by continuous scrolling", () => {
    const finalLine = "body-999-END-界";
    const body = Array.from(
      { length: 1_000 },
      (_, index) => index === 999 ? finalLine : `body-${index}`,
    ).join("\n");
    let state = createDisclosureViewState({
      nodes: fixture(body),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 9,
      headerLines: ["header"],
      composerLines: ["Request >"],
      footerLines: ["status"],
      anchorScreenRow: 3,
    });

    const initial = renderDisclosureView(state);
    assert.equal(initial.viewport.totalDocumentRows, 1_005);
    assert.equal(
      initial.rows.some((line) => /truncated|hidden|page \d/iu.test(line)),
      false,
    );

    // Offsets move by arbitrary line counts; there are no page boundaries.
    const initialOffset = initial.viewport.scrollOffset;
    state = scrollDisclosureView(state, 17);
    assert.equal(
      renderDisclosureView(state).viewport.scrollOffset,
      initialOffset + 17,
    );
    state = scrollDisclosureView(state, 23);
    assert.equal(
      renderDisclosureView(state).viewport.scrollOffset,
      initialOffset + 40,
    );
    state = scrollDisclosureView(state, 10_000);
    const end = renderDisclosureView(state);
    assert.ok(end.viewport.lines.some((line) => line.text === finalLine));
    assert.equal(
      state.nodes.find((node) => node.id === "target")?.kind === "adjustment"
        ? (state.nodes.find((node) => node.id === "target") as Extract<
          VirtualDocumentNode,
          { kind: "adjustment" }
        >).body.endsWith("END-界")
        : false,
      true,
    );
  });

  it("replaces preview and body at the same anchored title without duplicates", () => {
    let state = createDisclosureViewState({
      nodes: fixture("full-A\nfull-B\nfull-C"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 9,
      headerLines: ["header"],
      composerLines: ["Request >"],
      footerLines: ["status"],
      anchorScreenRow: 4,
      expanded: false,
    });
    const collapsed = renderDisclosureView(state);
    assert.equal(collapsed.viewport.targetTitleScreenRow, 4);
    assert.equal(collapsed.rows.filter((line) => line === "Adjustment #2").length, 1);
    assert.equal(collapsed.rows.filter((line) => line === "requested change preview").length, 1);

    state = toggleDisclosureView(state, undefined, true);
    const expanded = renderDisclosureView(state);
    assert.equal(expanded.viewport.targetTitleScreenRow, 4);
    assert.equal(expanded.rows.filter((line) => line === "Adjustment #2").length, 1);
    assert.equal(expanded.rows.includes("requested change preview"), false);
    assert.ok(expanded.rows.includes("full-A"));

    state = toggleDisclosureView(state, undefined, false);
    const collapsedAgain = renderDisclosureView(state);
    assert.equal(collapsedAgain.viewport.targetTitleScreenRow, 4);
    assert.equal(collapsedAgain.rows.filter((line) => line === "Adjustment #2").length, 1);
    assert.equal(
      collapsedAgain.rows.filter((line) => line === "requested change preview").length,
      1,
    );
    assert.equal(collapsedAgain.rows.some((line) => /^full-/u.test(line)), false);
  });

  it("preserves an anchored visible title across resize and appended output", () => {
    let state = createDisclosureViewState({
      nodes: fixture("long body line that wraps after resizing\nsecond line"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 11,
      headerLines: ["header"],
      composerLines: ["Request >"],
      footerLines: ["status"],
      anchorScreenRow: 5,
    });
    assert.equal(renderDisclosureView(state).viewport.targetTitleScreenRow, 5);

    state = resizeDisclosureView(state, 24, 12);
    const resized = renderDisclosureView(state);
    assert.equal(resized.viewport.targetTitleScreenRow, 5);
    assert.equal(resized.rows.length, 12);

    state = appendDisclosureViewNode(state, {
      id: "new-answer",
      kind: "text",
      text: "new output one\nnew output two",
    });
    assert.equal(renderDisclosureView(state).viewport.targetTitleScreenRow, 5);

    state = scrollDisclosureViewToEnd(state);
    assert.ok(renderDisclosureView(state).viewport.lines.some(
      (line) => line.nodeId === "new-answer" && line.text === "new output two",
    ));
  });

  it("updates chrome subsets while keeping a visible title on its screen row", () => {
    let state = createDisclosureViewState({
      nodes: fixture("body one\nbody two\nbody three"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 12,
      headerLines: ["old header"],
      composerLines: ["old request"],
      footerLines: ["old status"],
      anchorScreenRow: 5,
    });
    const before = renderDisclosureView(state);
    assert.equal(before.viewport.targetTitleScreenRow, 5);

    state = updateDisclosureViewChrome(state, {
      composerLines: ["new request one", "new request two", "new request three"],
    });
    const after = renderDisclosureView(state);

    assert.equal(after.viewport.targetTitleScreenRow, 5);
    assert.deepEqual(state.headerLines, ["old header"]);
    assert.deepEqual(state.footerLines, ["old status"]);
    assert.deepEqual(state.composerLines, [
      "new request one",
      "new request two",
      "new request three",
    ]);
    assert.equal(after.visibleRows.filter((row) => row.region === "composer").length, 3);
    assert.equal(after.rows.length, 12);
  });

  it("clamps a visible title when growing chrome consumes its previous row", () => {
    let state = createDisclosureViewState({
      nodes: fixture("complete body"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 9,
      headerLines: ["header"],
      composerLines: ["request"],
      footerLines: ["status"],
      anchorScreenRow: 5,
    });
    assert.equal(renderDisclosureView(state).viewport.targetTitleScreenRow, 5);

    state = updateDisclosureViewChrome(state, {
      composerLines: ["request 1", "request 2", "request 3", "request 4"],
      footerLines: ["status 1", "status 2"],
    });
    const frame = renderDisclosureView(state);

    // Header occupies row 0; transcript can now occupy only rows 1 and 2.
    assert.equal(frame.viewport.viewportRows, 2);
    assert.equal(frame.viewport.targetTitleScreenRow, 2);
    assert.equal(state.anchorScreenRow, 2);
    assert.equal(frame.rows.length, 9);
  });

  it("preserves off-screen scrolling and recalculates follow-tail after chrome changes", () => {
    const longNodes: readonly VirtualDocumentNode[] = [
      ...fixture("target body"),
      {
        id: "long-tail",
        kind: "text",
        text: Array.from({ length: 30 }, (_, index) => `tail-${index}`).join("\n"),
      },
    ];
    let state = createDisclosureViewState({
      nodes: longNodes,
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 10,
      composerLines: ["request"],
      footerLines: ["status"],
      anchorScreenRow: 3,
    });
    state = scrollDisclosureView(state, 12);
    const scrolled = renderDisclosureView(state);
    assert.equal(scrolled.viewport.targetTitleScreenRow, undefined);
    const oldOffset = scrolled.viewport.scrollOffset;

    state = updateDisclosureViewChrome(state, {
      headerLines: ["new header"],
      composerLines: ["request one", "request two"],
    });
    assert.equal(renderDisclosureView(state).viewport.scrollOffset, oldOffset);
    assert.equal(state.followTail, false);

    state = scrollDisclosureViewToEnd(state);
    const oldMaximum = renderDisclosureView(state).viewport.maxScrollOffset;
    state = updateDisclosureViewChrome(state, {
      composerLines: ["request one", "request two", "request three"],
    });
    const atTail = renderDisclosureView(state);
    assert.equal(atTail.viewport.atEnd, true);
    assert.equal(state.followTail, true);
    assert.ok(atTail.viewport.maxScrollOffset > oldMaximum);
  });

  it("clears explicitly supplied chrome and rejects chrome that leaves no transcript", () => {
    const state = createDisclosureViewState({
      nodes: fixture("complete body"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 6,
      headerLines: ["header"],
      composerLines: ["request"],
      footerLines: ["status"],
      anchorScreenRow: 2,
    });
    const cleared = updateDisclosureViewChrome(state, {
      headerLines: [],
      footerLines: [],
    });
    assert.deepEqual(cleared.headerLines, []);
    assert.deepEqual(cleared.footerLines, []);
    assert.deepEqual(cleared.composerLines, ["request"]);
    assert.equal(renderDisclosureView(cleared).rows.length, 6);

    assert.throws(
      () => updateDisclosureViewChrome(state, {
        composerLines: ["one", "two", "three", "four"],
      }),
      /requires at least one transcript row/u,
    );
  });

  it("can switch targets while retaining full bodies in model state", () => {
    let state = createDisclosureViewState({
      nodes: fixture("target complete"),
      target: { id: "target", kind: "adjustment" },
      columns: 80,
      rows: 8,
      composerLines: ["Request >"],
      anchorScreenRow: 3,
    });
    state = toggleDisclosureView(
      state,
      { id: "old-thinking", kind: "thinking" },
      true,
    );
    const frame = renderDisclosureView(state);
    assert.equal(frame.viewport.targetTitleScreenRow, 1);
    assert.ok(frame.viewport.lines.some(
      (line) => line.nodeId === "old-thinking" && line.part === "body",
    ));
    assert.ok(frame.viewport.lines.some(
      (line) => line.nodeId === "target" && line.part === "preview",
    ));
    assert.equal(
      state.nodes.find((node) => node.id === "target")?.kind === "adjustment"
        ? (state.nodes.find((node) => node.id === "target") as Extract<
          VirtualDocumentNode,
          { kind: "adjustment" }
        >).body
        : "",
      "target complete",
    );
  });
});
