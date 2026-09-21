import assert from "node:assert/strict";
import { composeMessage, composerEnterAction, composerPrimaryAction, LONG_PASTE_THRESHOLD, matchingSlashCommands, pastedTextPreview } from "../src/web/composer-content.js";
import { activeMessageIdsForViewport, displayProject, displayTitle, groupConversationTools, groupConversationTurns, isConversationEntry, isNoticeEntry, toolRunContinuesAcross } from "../src/web/display-content.js";
import type { WebEntry } from "../src/web-contracts.js";
import { describe, it } from "./harness.js";

describe("Web composer pasted text", () => {
  it("shows only an opening preview while retaining the full pasted content", () => {
    const content = `first line\n${"later content ".repeat(150)}`;
    assert.ok(content.length >= LONG_PASTE_THRESHOLD);
    assert.match(pastedTextPreview(content), /^first line later content/);
    assert.ok(pastedTextPreview(content).length <= 141);
    assert.equal(composeMessage("Please inspect this", [{ id: "paste-1", content }]),
      `Please inspect this\n\n[Pasted text 1]\n${content}\n[/Pasted text 1]`);
  });

  it("keeps multiple pasted blocks in order without needing editable text", () => {
    assert.equal(composeMessage("", [
      { id: "a", content: "alpha" }, { id: "b", content: "beta" },
    ]), "[Pasted text 1]\nalpha\n[/Pasted text 1]\n\n[Pasted text 2]\nbeta\n[/Pasted text 2]");
  });
});

describe("Web composer command completion", () => {
  const commands = ["mode", "memory", "mcp", "status", "skills"];

  it("lists every matching prefix and hides the menu for non-matches or arguments", () => {
    assert.deepEqual(matchingSlashCommands("/m", commands), ["mode", "memory", "mcp"]);
    assert.deepEqual(matchingSlashCommands("/", commands), commands);
    assert.deepEqual(matchingSlashCommands("/xyz", commands), []);
    assert.deepEqual(matchingSlashCommands("/memory long", commands), []);
    assert.deepEqual(matchingSlashCommands("Please run /mcp", commands), []);
  });
});

describe("Web composer Enter behavior", () => {
  const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, keyCode: 13, repeat: false };

  it("sends only on unmodified Enter and allows only Shift+Enter to insert a newline", () => {
    assert.equal(composerEnterAction(enter), "send");
    assert.equal(composerEnterAction({ ...enter, shiftKey: true }), "newline");
    assert.equal(composerEnterAction({ ...enter, key: "A" }), "none");
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      assert.equal(composerEnterAction({ ...enter, [modifier]: true }), "suppress");
      assert.equal(composerEnterAction({ ...enter, [modifier]: true, shiftKey: true }), "suppress");
    }
    assert.equal(composerEnterAction({ ...enter, repeat: true }), "suppress");
  });

  it("does not send while an input method is confirming a character", () => {
    assert.equal(composerEnterAction({ ...enter, isComposing: true }), "none");
    assert.equal(composerEnterAction({ ...enter, keyCode: 229 }), "none");
    assert.equal(composerEnterAction(enter, true), "none");
    assert.equal(composerEnterAction(enter, false, true), "suppress");
  });
});

describe("Web composer primary action", () => {
  it("stops an active task only when no adjustment is drafted", () => {
    assert.equal(composerPrimaryAction(true, false), "stop");
    assert.equal(composerPrimaryAction(true, true), "send");
    assert.equal(composerPrimaryAction(false, true), "send");
  });
});

describe("Web conversation display", () => {
  const entry = (kind: WebEntry["kind"]): WebEntry => ({ id: kind, kind, text: kind, timestamp: 0 });

  it("keeps conversation evidence in the transcript and routes notices elsewhere", () => {
    for (const kind of ["user", "assistant", "thinking", "tool", "plan"] as const)
      assert.equal(isConversationEntry(entry(kind)), true);
    for (const kind of ["info", "success", "warning", "error"] as const)
      assert.equal(isNoticeEntry(entry(kind)), true);
  });
  it("groups adjacent tool calls but leaves a single call and conversation boundaries unchanged", () => {
    const tool = (id: string): WebEntry => ({ id, kind: "tool", text: `✓ ${id}`, toolName: id, timestamp: 0 });
    assert.deepEqual(groupConversationTools([tool("one")]).map(item => item.kind), ["entry"]);
    const grouped = groupConversationTools([
      entry("user"), tool("read_file"), tool("mcp__server__search"),
      entry("thinking"), tool("run_command"), tool("create_file"), entry("assistant"),
    ]);
    assert.deepEqual(grouped.map(item => item.kind), ["entry", "tool-group", "entry", "tool-group", "entry"]);
    assert.deepEqual(grouped[1]?.kind === "tool-group" ? grouped[1].tools.map(item => item.toolName) : [],
      ["read_file", "mcp__server__search"]);
  });
  it("keeps a tool run intact across hidden notices and a live-window cutoff", () => {
    const entries: WebEntry[] = [
      { id: "a", kind: "tool", text: "✓ read_file", timestamp: 0 },
      { id: "status", kind: "info", text: "Step 2", timestamp: 1 },
      { id: "b", kind: "tool", text: "✓ mcp__server__search", timestamp: 2 },
      { id: "answer", kind: "assistant", text: "Done", timestamp: 3 },
    ];
    assert.equal(toolRunContinuesAcross(entries, 1), true);
    assert.equal(toolRunContinuesAcross(entries, 2), true);
    assert.equal(toolRunContinuesAcross(entries, 3), false);
  });
  it("keeps a running turn flat, then separates only its accepted final answer", () => {
    const base = { turnId: "turn-1", turnStartedAt: 1_000 };
    const entries: WebEntry[] = [
      { ...base, id: "request", kind: "user", text: "Fix it", timestamp: 1_000 },
      { ...base, id: "thought", kind: "thinking", text: "Inspect", timestamp: 1_100 },
      { ...base, id: "intermediate", kind: "assistant", text: "I will inspect.", timestamp: 1_200 },
      { ...base, id: "tool", kind: "tool", text: "✓ read_file", timestamp: 1_300 },
      { ...base, id: "final", kind: "assistant", text: "Done", timestamp: 3_500,
        answerState: "confirmed", turnCompletedAt: 3_500 },
    ];
    const [turn] = groupConversationTurns(entries);
    assert.equal(turn?.request?.id, "request");
    assert.equal(turn?.finalAnswer?.id, "final");
    assert.equal(turn?.status, "completed");
    assert.equal(turn?.completedAt, 3_500);
    assert.deepEqual(turn?.processItems.map(item => item.id), ["thought", "intermediate", "tool"]);
    assert.deepEqual(turn?.liveItems.map(item => item.id), ["request", "thought", "intermediate", "tool", "final"]);
  });
  it("collapses process items as soon as an explicit final answer starts", () => {
    const base = { turnId: "turn-live", turnStartedAt: 1_000 };
    const [turn] = groupConversationTurns([
      { ...base, id: "request", kind: "user", text: "Fix it", timestamp: 1_000 },
      { ...base, id: "tool", kind: "tool", text: "✓ read_file", timestamp: 1_200 },
      { ...base, id: "answer", kind: "assistant", text: "The fix is", timestamp: 1_300,
        answerState: "finalizing" },
    ]);
    assert.equal(turn?.status, "finalizing");
    assert.equal(turn?.completedAt, undefined);
    assert.equal(turn?.finalAnswer?.id, "answer");
    assert.deepEqual(turn?.processItems.map(item => item.id), ["tool"]);
  });
});

describe("Web message rail location", () => {
  const viewport = { top: 100, bottom: 300 };

  it("uses directly visible user messages before a containing turn", () => {
    assert.deepEqual(activeMessageIdsForViewport(viewport, [
      { id: "first", top: 120, bottom: 150 },
      { id: "second", top: 280, bottom: 320 },
    ], [{ requestId: "older", top: 0, bottom: 500 }]), ["first", "second"]);
  });

  it("keeps the current turn highlighted after its request scrolls above the viewport", () => {
    assert.deepEqual(activeMessageIdsForViewport(viewport,
      [{ id: "request", top: 20, bottom: 60 }],
      [{ requestId: "request", top: 20, bottom: 700 }]), ["request"]);
  });

  it("chooses the turn containing the viewport top when two turns are visible", () => {
    assert.deepEqual(activeMessageIdsForViewport(viewport,
      [{ id: "first", top: 0, bottom: 30 }, { id: "second", top: 310, bottom: 340 }],
      [{ requestId: "first", top: 0, bottom: 130 }, { requestId: "second", top: 130, bottom: 500 }]), ["first"]);
  });

  it("falls back to the closest earlier request and stays empty for an empty thread", () => {
    assert.deepEqual(activeMessageIdsForViewport(viewport, [
      { id: "old", top: 0, bottom: 20 }, { id: "recent", top: 60, bottom: 90 },
    ], []), ["recent"]);
    assert.deepEqual(activeMessageIdsForViewport(viewport, [], []), []);
  });
});

describe("Web header title", () => {
  const project = { id: "project-1", root: "C:\\work\\example", name: "My project" };
  const thread = { threadId: "thread-1", workspaceId: project.id, workspaceRoot: project.root,
    title: "Custom conversation", canRename: false, mode: "code", provider: "qwen", model: "test", updatedAt: "2026-01-01" };

  it("uses the conversation name when a project thread is selected", () => {
    const selected = displayProject(thread.threadId, project.root, [thread], [project], undefined);
    assert.equal(displayTitle(thread.threadId, selected, [thread]), "Custom conversation");
  });

  it("uses the project name when only a project is selected", () => {
    const selected = displayProject(undefined, undefined, [thread], [project], project.id);
    assert.equal(displayTitle(undefined, selected, [thread]), "My project");
  });

  it("uses the conversation name when its workspace is not a registered project", () => {
    const selected = displayProject(thread.threadId, project.root, [thread], [], project.id);
    assert.equal(displayTitle(thread.threadId, selected, [thread]), "Custom conversation");
  });

  it("does not mistake the last selected project for an unrelated conversation", () => {
    const selected = displayProject("other-thread", "C:\\elsewhere", [thread], [project], project.id);
    assert.equal(selected, undefined);
    assert.equal(displayTitle("other-thread", selected, [thread]), "Thread other-th");
  });
});
