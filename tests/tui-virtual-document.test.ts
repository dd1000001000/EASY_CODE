import assert from "node:assert/strict";

import {
  appendVirtualDocumentNode,
  applyVirtualViewportCommand,
  createVirtualViewportState,
  layoutVirtualDocument,
  pageDownVirtualViewport,
  pageUpVirtualViewport,
  renderVirtualViewport,
  resizeVirtualViewport,
  scrollVirtualViewport,
  scrollVirtualViewportToEnd,
  toggleVirtualDisclosure,
  type VirtualDocumentNode,
} from "../src/ui/tui/virtual-document.js";
import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

function lineTexts(nodes: readonly VirtualDocumentNode[], columns = 80): string[] {
  return layoutVirtualDocument(nodes, columns).lines.map((line) => line.text);
}

describe("virtual terminal document", () => {
  it("lays out ordinary text, Thinking, and Adjustment without mutating content", () => {
    const thinkingBody = "complete thinking line one\ncomplete thinking line two";
    const adjustmentBody = "first requested change\nsecond requested change";
    const nodes: readonly VirtualDocumentNode[] = [
      { id: "answer", kind: "text", text: "ordinary answer" },
      {
        id: "thinking-1",
        kind: "thinking",
        title: "Thinking #1",
        preview: "thinking preview",
        body: thinkingBody,
        expanded: false,
      },
      {
        id: "adjustment-1",
        kind: "adjustment",
        title: "Adjustment #1",
        preview: "adjustment preview",
        body: adjustmentBody,
        expanded: true,
      },
    ];

    const layout = layoutVirtualDocument(nodes, 80);
    assert.deepEqual(layout.lines.map((line) => [line.part, line.text]), [
      ["text", "ordinary answer"],
      ["title", "Thinking #1"],
      ["preview", "thinking preview"],
      ["title", "Adjustment #1"],
      ["body", "first requested change"],
      ["body", "second requested change"],
    ]);
    assert.equal(nodes[1]?.kind === "thinking" ? nodes[1].body : "", thinkingBody);
    assert.equal(
      nodes[2]?.kind === "adjustment" ? nodes[2].body : "",
      adjustmentBody,
    );
  });

  it("wraps every row to terminal columns without inserting omission markers", () => {
    const body = "A中文B\nplain text";
    const nodes: readonly VirtualDocumentNode[] = [{
      id: "thinking",
      kind: "thinking",
      title: "标题",
      preview: "预览",
      body,
      expanded: true,
    }];

    const layout = layoutVirtualDocument(nodes, 3);
    assert.deepEqual(layout.lines.map((line) => line.text), [
      "标",
      "题",
      "A中",
      "文B",
      "pla",
      "in ",
      "tex",
      "t",
    ]);
    for (const line of layout.lines) assert.ok(displayWidth(line.text) <= 3);
    assert.equal(layout.lines.some((line) => /truncated|hidden/iu.test(line.text)), false);
  });

  it("keeps disclosure body styling on every physical row after wrapping", () => {
    const layout = layoutVirtualDocument([{
      id: "thinking",
      kind: "thinking",
      title: "Thinking #1",
      preview: "preview",
      body: "\u001B[90mThe complete thinking body remains gray while it wraps.\u001B[0m",
      expanded: true,
    }], 16, { preserveAnsi: true });
    const bodyRows = layout.lines.filter((line) => line.part === "body");

    assert.ok(bodyRows.length > 1);
    for (const row of bodyRows) {
      assert.ok(row.text.startsWith("\u001B[90m"));
      assert.ok(row.text.endsWith("\u001B[0m"));
    }
    assert.equal(
      bodyRows.map((row) => stripAnsi(row.text)).join(""),
      "The complete thinking body remains gray while it wraps.",
    );
  });

  it("retains an arbitrarily long expanded body outside the physical viewport", () => {
    const bodyLines = Array.from({ length: 250 }, (_, index) => `body-${index}`);
    const body = bodyLines.join("\n");
    const state = createVirtualViewportState({
      columns: 80,
      viewportRows: 7,
      followTail: false,
      nodes: [{
        id: "adjustment",
        kind: "adjustment",
        title: "Adjustment #9",
        preview: "short preview",
        body,
        expanded: true,
      }],
    });

    const layout = layoutVirtualDocument(state.nodes, state.columns);
    assert.equal(layout.totalRows, 251);
    assert.equal(layout.lines.filter((line) => line.part === "body").length, 250);
    assert.equal(
      state.nodes[0]?.kind === "adjustment" ? state.nodes[0].body : "",
      body,
    );
    const first = renderVirtualViewport(state);
    assert.equal(first.lines.length, 7);
    assert.deepEqual(first.lines.map((line) => line.text), [
      "Adjustment #9",
      "body-0",
      "body-1",
      "body-2",
      "body-3",
      "body-4",
      "body-5",
    ]);
    assert.equal(first.lines.some((line) => /later|truncated|hidden/iu.test(line.text)), false);
  });

  it("replaces preview with body in place and anchors the visible title row", () => {
    const prefix = Array.from({ length: 10 }, (_, index) => `before-${index}`).join("\n");
    let state = createVirtualViewportState({
      columns: 80,
      viewportRows: 6,
      scrollOffset: 8,
      followTail: false,
      nodes: [
        { id: "prefix", kind: "text", text: prefix },
        {
          id: "thinking",
          kind: "thinking",
          title: "Thinking #4",
          preview: "one-line preview",
          body: "full-0\nfull-1\nfull-2\nfull-3\nfull-4\nfull-5",
          expanded: false,
        },
        {
          id: "suffix",
          kind: "text",
          text: Array.from({ length: 10 }, (_, index) => `after-${index}`).join("\n"),
        },
      ],
    });

    const before = renderVirtualViewport(state);
    const beforeTitle = before.lines.findIndex((line) => line.nodeId === "thinking");
    assert.equal(beforeTitle, 2);
    assert.ok(before.lines.some((line) => line.part === "preview"));

    state = toggleVirtualDisclosure(state, "thinking", true);
    const after = renderVirtualViewport(state);
    const afterTitle = after.lines.findIndex((line) => line.nodeId === "thinking");
    assert.equal(afterTitle, beforeTitle);
    assert.equal(after.lines.some((line) => line.part === "preview"), false);
    assert.ok(after.lines.some((line) => line.part === "body"));
    assert.equal(state.followTail, false);

    state = toggleVirtualDisclosure(state, "thinking", false);
    const collapsed = renderVirtualViewport(state);
    assert.equal(
      collapsed.lines.findIndex((line) => line.nodeId === "thinking"),
      beforeTitle,
    );
    assert.equal(collapsed.lines.some((line) => line.part === "body"), false);
    assert.ok(collapsed.lines.some((line) => line.part === "preview"));
  });

  it("keeps follow-tail on appended output until the user scrolls away", () => {
    let state = createVirtualViewportState({
      columns: 80,
      viewportRows: 3,
      nodes: [{
        id: "initial",
        kind: "text",
        text: Array.from({ length: 6 }, (_, index) => `line-${index}`).join("\n"),
      }],
    });
    assert.equal(renderVirtualViewport(state).scrollOffset, 3);

    state = appendVirtualDocumentNode(state, {
      id: "new-tail",
      kind: "text",
      text: "tail-a\ntail-b",
    });
    assert.equal(renderVirtualViewport(state).scrollOffset, 5);
    assert.equal(state.followTail, true);

    state = scrollVirtualViewport(state, -2);
    assert.equal(state.scrollOffset, 3);
    assert.equal(state.followTail, false);
    state = appendVirtualDocumentNode(state, {
      id: "later",
      kind: "text",
      text: "later output",
    });
    assert.equal(state.scrollOffset, 3);

    state = scrollVirtualViewportToEnd(state);
    assert.equal(state.followTail, true);
    assert.equal(renderVirtualViewport(state).atEnd, true);
  });

  it("supports line, PageUp/PageDown, Home/End, and follow-tail commands", () => {
    let state = createVirtualViewportState({
      columns: 80,
      viewportRows: 5,
      nodes: [{
        id: "long",
        kind: "text",
        text: Array.from({ length: 20 }, (_, index) => String(index)).join("\n"),
      }],
    });
    assert.equal(state.scrollOffset, 15);

    state = pageUpVirtualViewport(state);
    assert.equal(state.scrollOffset, 11);
    assert.equal(state.followTail, false);
    state = pageDownVirtualViewport(state);
    assert.equal(state.scrollOffset, 15);
    assert.equal(state.followTail, true);

    state = applyVirtualViewportCommand(state, { type: "scroll-start" });
    assert.equal(state.scrollOffset, 0);
    state = applyVirtualViewportCommand(state, { type: "scroll-lines", lines: 2 });
    assert.equal(state.scrollOffset, 2);
    state = applyVirtualViewportCommand(state, { type: "scroll-end" });
    assert.equal(state.scrollOffset, 15);
    state = applyVirtualViewportCommand(state, { type: "follow-tail", enabled: false });
    assert.equal(state.followTail, false);
  });

  it("best-effort anchors the first visible node when terminal width changes", () => {
    let state = createVirtualViewportState({
      columns: 8,
      viewportRows: 3,
      scrollOffset: 1,
      followTail: false,
      nodes: [
        { id: "first", kind: "text", text: "abcdefghABCDEFGH" },
        {
          id: "second",
          kind: "text",
          text: "second\nthird\nfourth\nfifth\nsixth\nseventh",
        },
      ],
    });
    assert.equal(renderVirtualViewport(state).lines[0]?.nodeId, "first");
    assert.equal(renderVirtualViewport(state).lines[0]?.nodeRow, 1);

    state = resizeVirtualViewport(state, 4, 3);
    const resized = renderVirtualViewport(state);
    assert.equal(resized.lines[0]?.nodeId, "first");
    assert.equal(resized.lines[0]?.nodeRow, 1);
  });

  it("rejects ambiguous duplicate IDs and ignores unknown disclosure IDs", () => {
    assert.throws(
      () => layoutVirtualDocument([
        { id: "same", kind: "text", text: "a" },
        { id: "same", kind: "text", text: "b" },
      ], 80),
      /Duplicate virtual document node ID/u,
    );
    const state = createVirtualViewportState({
      columns: 80,
      viewportRows: 10,
      nodes: [{ id: "plain", kind: "text", text: "plain" }],
    });
    assert.equal(toggleVirtualDisclosure(state, "missing"), state);
    assert.equal(toggleVirtualDisclosure(state, "plain"), state);
  });

  it("renders every logical row in order as the viewport scrolls", () => {
    const nodes: readonly VirtualDocumentNode[] = [{
      id: "all",
      kind: "text",
      text: Array.from({ length: 17 }, (_, index) => `row-${index}`).join("\n"),
    }];
    let state = createVirtualViewportState({
      columns: 80,
      viewportRows: 1,
      scrollOffset: 0,
      followTail: false,
      nodes,
    });
    const seen: string[] = [];
    for (let offset = 0; offset < 17; offset += 1) {
      state = { ...state, scrollOffset: offset };
      const first = renderVirtualViewport(state).lines[0]?.text;
      if (first !== undefined) seen.push(first);
    }
    assert.deepEqual(seen, lineTexts(nodes));
  });
});
