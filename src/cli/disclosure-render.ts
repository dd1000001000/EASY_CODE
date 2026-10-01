/** Pure rendering for the alternate-screen disclosure viewer: its document, chrome, and editor key mapping. */

import chalk from "chalk";
import type { Language } from "../i18n/language.js";
import type { UIState, UITranscriptEntry } from "../ui/contracts.js";
import { displayWidth, stripAnsi, truncateToWidth, wrapToWidth } from "../ui/render/layout.js";
import { renderFixedBottomRegions, renderLiveActivityRegion, renderSessionHeader } from "../ui/render/view.js";
import {
  layoutVirtualDocument,
  renderDisclosureView,
  updateDisclosureViewChrome,
  type DisclosureViewFrame,
  type DisclosureViewState,
  type DisclosureViewTarget,
  type VirtualDocumentNode,
} from "../ui/tui/index.js";
import { VSCODE_IMAGE_PASTE_SEQUENCE } from "./prompt-input.js";
import { renderReasoningMarker, type ReasoningBlock } from "./reasoning.js";
import type { TuiInputEvent } from "./tui-input.js";

export type DisclosureKind = "thinking" | "adjustment";

/** The Terminal's current view settings, shared by every rendered region. */
export interface TerminalViewOptions {
  columns: number;
  language: Language;
  rows?: number;
  color: boolean;
  agentConcurrencyLimit?: number;
  spinnerFrame: number;
}

/** Live progress of a Thinking block that is still streaming. */
export interface LiveReasoningSource {
  readonly previewLimitChars: number;
  activeReasoningStream(
    blockId: number,
  ): Readonly<{ reasoningSourceChars: number; reasoningLastDeltaAtMs?: number }> | undefined;
}

export function virtualDisclosureId(kind: DisclosureKind, id: number): string {
  return `${kind}:${id}`;
}

export function disclosureTarget(kind: DisclosureKind, id: number): DisclosureViewTarget {
  return { id: virtualDisclosureId(kind, id), kind };
}

export function registryIdFromVirtualNode(nodeId: string, kind: DisclosureKind): number | undefined {
  const match = new RegExp(`^${kind}:([1-9][0-9]{0,15})$`, "u").exec(nodeId);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** Translate a full-screen input event back into the bytes readline expects on stdin. */
export function disclosureEditorInput(event: Readonly<TuiInputEvent>): Buffer | string | undefined {
  if (event.type === "text") return event.text;
  if (event.type === "paste") {
    return `\u001B[200~${event.text}\u001B[201~`;
  }
  if (event.type === "paste-image") return VSCODE_IMAGE_PASTE_SEQUENCE;
  if (event.type !== "key") return undefined;
  switch (event.key) {
    case "left":
      return "\u001B[D";
    case "right":
      return "\u001B[C";
    case "up":
      return "\u001B[A";
    case "down":
      return "\u001B[B";
    case "home":
      return "\u001B[H";
    case "end":
      return "\u001B[F";
    case "backspace":
      return Buffer.from([0x7f]);
    case "delete":
      return "\u001B[3~";
    case "enter":
      return "\r";
    case "newline":
      return "\u001B\r";
    case "tab":
      return "\t";
    case "interrupt":
    case "page-up":
    case "page-down":
      return undefined;
  }
}

export function formatSubmittedRequest(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized
    .split("\n")
    .map((line, index) => `${index === 0 ? `${chalk.cyan.bold("›")} ` : "  "}${line}`)
    .join("\n");
}

export function formatUserTranscriptEntry(entry: Pick<UITranscriptEntry, "text" | "images">): string {
  const images = entry.images
    ?.map((image) => `[${image.label}]`)
    .filter((label) => !entry.text.includes(label))
    .join(" ");
  return formatSubmittedRequest([entry.text, images].filter(Boolean).join(" "));
}

/**
 * The alternate buffer is a lossless projection of the complete session.
 * Thinking markers are committed at event time, so walking the transcript
 * preserves the exact order visible in primary scrollback. The mutable
 * retained registry supplies bodies for visible markers from any turn; it
 * is not a second visual tail. Only the selected marker changes in place.
 */
export function disclosureDocumentNodes(
  transcript: readonly Readonly<UITranscriptEntry>[],
  retainedReasoning: ReadonlyMap<string, Readonly<ReasoningBlock>>,
  live: LiveReasoningSource,
  activeKind?: DisclosureKind,
  activeId?: number,
): readonly VirtualDocumentNode[] {
  const nodes: VirtualDocumentNode[] = [];
  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (!entry) continue;
    const reasoning = entry.id ? retainedReasoning.get(entry.id) : undefined;
    if (reasoning) {
      nodes.push(reasoningDisclosureNode(reasoning, activeKind === "thinking" && activeId === reasoning.id, live));
      continue;
    }
    nodes.push({
      id: `transcript:${index}`,
      kind: "text",
      text: CONVERSATION_ITEM_KINDS.has(entry.kind)
        ? conversationItemText(entry.kind === "user" ? formatUserTranscriptEntry(entry) : entry.text)
        : entry.text,
    });
  }
  return nodes;
}

const CONVERSATION_ITEM_KINDS = new Set<UITranscriptEntry["kind"]>(["user", "assistant", "tool"]);

/**
 * Scrollback text ends with line terminators, but every trailing newline of a
 * document node is a visible row. Give each conversation item exactly one
 * blank row above it instead, so requests, answers and tool calls are evenly
 * spaced however their scrollback text was terminated.
 */
function conversationItemText(text: string): string {
  return `\n${text.replace(/^\n+|\n+$/gu, "")}`;
}

function reasoningDisclosureNode(
  block: Readonly<ReasoningBlock>,
  active: boolean,
  live: LiveReasoningSource,
): VirtualDocumentNode {
  const activeStream = live.activeReasoningStream(block.id);
  const marker = stripAnsi(
    renderReasoningMarker(block, {
      color: false,
      ...(activeStream?.reasoningLastDeltaAtMs === undefined
        ? {}
        : {
            live: {
              sourceChars: activeStream.reasoningSourceChars,
              previewLimitChars: live.previewLimitChars,
              lastDeltaAtMs: activeStream.reasoningLastDeltaAtMs,
            },
          }),
    }),
  )
    .trimEnd()
    .split("\n");
  return {
    id: virtualDisclosureId("thinking", block.id),
    kind: "thinking",
    title: active
      ? chalk.gray(`↕ Thinking #${block.id} · VS Code Ctrl/Cmd+click to toggle`)
      : chalk.gray(marker[0] ?? `▶ Thinking #${block.id}`),
    preview: chalk.gray(marker.slice(1).join("\n")),
    body: chalk.gray(
      (block.text || "(No visible Thinking text.)")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ),
    expanded: active,
  };
}

export function disclosureHeaderLines(
  state: Readonly<UIState>,
  view: TerminalViewOptions,
  columns: number,
): readonly string[] {
  // The alternate-screen viewer is another projection of the same session,
  // not a separate page with its own compact identity. Reuse the canonical
  // header so title, provider label, context, workspace, Thread ID, and
  // sanitization remain byte-for-byte consistent across the toggle.
  return renderSessionHeader(state, {
    ...view,
    columns,
  }).split("\n");
}

export function disclosureComposerLines(
  state: Readonly<UIState>,
  view: TerminalViewOptions,
  columns: number,
  rows: number,
): readonly string[] {
  // An idle composer is self-evident; only the busy state, where input
  // adjusts the running task instead of starting one, is labelled.
  const fitted = state.composer.busy
    ? truncateToWidth(" Adjust current task ", Math.max(1, columns - 3), {
        preserveAnsi: false,
      })
    : "";
  const fill = "─".repeat(Math.max(0, columns - 3 - displayWidth(fitted)));
  const text = state.composer.text;
  const cursor = Math.max(0, Math.min(text.length, state.composer.cursor));
  const attachmentSuffix = state.composer.images
    .map((image) => `[${image.label}]`)
    .filter((marker) => !text.includes(marker))
    .join(" ");
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const completionSuffix = cursor === text.length ? (state.composer.completionSuffix ?? "") : "";
  const placeholder =
    state.composer.placeholder ||
    (state.composer.busy ? "Type an adjustment for the current task…" : "Type your request…");
  const visibleDraft =
    text || attachmentSuffix
      ? `${before}${chalk.inverse(" ")}${chalk.gray(completionSuffix)}${after}` +
        `${attachmentSuffix ? `${text ? " " : ""}${attachmentSuffix}` : ""}`
      : `${chalk.inverse(" ")}${chalk.gray(placeholder)}`;
  const interiorWidth = Math.max(1, columns - 4);
  const allRows = wrapToWidth(`${chalk.cyan.bold("›")} ${visibleDraft}`, interiorWidth, {
    preserveAnsi: true,
    hangingIndent: true,
  });
  // A very large draft remains fully retained in readline. Limit only the
  // on-screen composer window so complete Thinking/Adjustment content keeps
  // at least one transcript row, and mark either omitted side explicitly.
  // The full-screen shell always reserves useful vertical space for the
  // conversation plus status/tasks/agents below this card. The complete
  // draft remains in readline; only a small cursor-centred window is shown.
  const maximumDraftRows = Math.max(1, Math.min(3, rows - 8));
  const cursorRow = Math.max(
    0,
    wrapToWidth(`› ${before}`, interiorWidth, { preserveAnsi: false, hangingIndent: true }).length - 1,
  );
  const start = Math.max(
    0,
    Math.min(Math.max(0, allRows.length - maximumDraftRows), cursorRow - Math.floor(maximumDraftRows / 2)),
  );
  const visibleRows = allRows.slice(start, start + maximumDraftRows);
  if (start > 0 && visibleRows.length > 0) {
    visibleRows[0] = chalk.gray("… ") + (visibleRows[0] ?? "");
  }
  if (start + visibleRows.length < allRows.length && visibleRows.length > 0) {
    visibleRows[visibleRows.length - 1] = (visibleRows.at(-1) ?? "") + chalk.gray(" …");
  }
  const framedRows = visibleRows.map((line) => {
    const clipped = truncateToWidth(line, interiorWidth, { preserveAnsi: true });
    const padding = " ".repeat(Math.max(0, interiorWidth - displayWidth(clipped)));
    return `${chalk.cyan("│")} ${clipped}${padding} ${chalk.cyan("│")}`;
  });
  const requestLines = [
    chalk.cyan(`╭─${fitted}${fill}╮`),
    ...framedRows,
    chalk.cyan(`╰${"─".repeat(Math.max(0, columns - 2))}╯`),
  ];
  const progress = renderLiveActivityRegion(state, Date.now(), {
    ...view,
    columns,
    rows,
    maxProgressRows: 2,
  })
    .split("\n")
    .filter(Boolean);
  const progressBudget = Math.max(0, Math.min(3, rows - 10));
  const progressLines =
    progressBudget === 0
      ? []
      : progress.length <= progressBudget
        ? progress
        : progressBudget >= 2
          ? [progress[0] ?? "", ...progress.slice(-(progressBudget - 1))]
          : progress.slice(-progressBudget);
  return [...progressLines, ...requestLines];
}

function wrappedRowCount(lines: readonly string[], columns: number): number {
  return lines.reduce(
    (total, line) =>
      total +
      wrapToWidth(line, columns, {
        preserveAnsi: true,
      }).length,
    0,
  );
}

export function disclosureFooterLines(
  state: Readonly<UIState>,
  view: TerminalViewOptions,
  columns: number,
  rows: number,
  composerLines: readonly string[],
): readonly string[] {
  const headerRows = wrappedRowCount(disclosureHeaderLines(state, view, columns), columns);
  const composerRows = wrappedRowCount(composerLines, columns);
  // Conversation history is the primary surface. Detail lists may use the
  // remaining rows, but never squeeze the managed transcript below a useful
  // viewport. The compact status row itself always remains visible.
  const transcriptReserve = Math.max(1, Math.min(12, Math.floor(rows * 0.35)));
  const bottomBudget = Math.max(1, rows - headerRows - composerRows - transcriptReserve);
  return renderFixedBottomRegions(state, { ...view, columns, rows }, Date.now(), {
    totalRows: bottomBudget,
    detailRows: Math.max(0, bottomBudget - 1),
  }).lines;
}

/** Keep one fixed-height footer synchronized with the continuous viewport. */
export function renderDisclosureFrameWithPosition(
  initialState: Readonly<DisclosureViewState>,
  uiState: Readonly<UIState>,
  view: TerminalViewOptions,
): {
  readonly state: DisclosureViewState;
  readonly frame: DisclosureViewFrame;
} {
  let state = initialState as DisclosureViewState;
  let frame = renderDisclosureView(state);
  const footerLines = disclosureFooterLines(uiState, view, state.columns, state.rows, state.composerLines);
  const footerChanged =
    footerLines.length !== state.footerLines.length ||
    footerLines.some((line, index) => line !== state.footerLines[index]);
  if (footerChanged) {
    state = updateDisclosureViewChrome(state, { footerLines });
    frame = renderDisclosureView(state);
  }
  return { state, frame };
}

/**
 * Place a complete disclosure without the arbitrary empty band produced by
 * a fixed percentage anchor. A short current-turn document stays attached
 * to the Request card; a long document keeps up to three preceding context
 * rows above the selected Thinking title and remains continuously scrollable.
 */
export function disclosureAnchorScreenRow(
  options: Readonly<{
    nodes: readonly VirtualDocumentNode[];
    target: Readonly<DisclosureViewTarget>;
    columns: number;
    rows: number;
    headerLines: readonly string[];
    composerLines: readonly string[];
    footerLines: readonly string[];
  }>,
): number {
  const headerRows = wrappedRowCount(options.headerLines, options.columns);
  const composerRows = wrappedRowCount(options.composerLines, options.columns);
  const footerRows = wrappedRowCount(options.footerLines, options.columns);
  const viewportRows = Math.max(1, options.rows - headerRows - composerRows - footerRows);
  const layout = layoutVirtualDocument(options.nodes, options.columns, {
    preserveAnsi: true,
  });
  const titleRow = layout.titleRows.get(options.target.id) ?? 0;

  if (layout.totalRows > viewportRows) {
    // Keep a small amount of stable-answer context above the selected
    // Thinking title. Pinning it to the absolute top made expansion look
    // like every preceding row had disappeared even though it was scrollable.
    const contextRows = Math.min(titleRow, 3, Math.max(0, viewportRows - 1));
    const maximumOffset = Math.max(0, layout.totalRows - viewportRows);
    const desiredOffset = Math.max(0, Math.min(titleRow - contextRows, maximumOffset));
    // Derive the physical anchor from the clamped ordinary viewport. A
    // target near the document tail therefore moves downward instead of
    // forcing overscroll and painting an artificial blank band below it.
    return headerRows + titleRow - desiredOffset;
  }

  // createDisclosureViewState derives scrollOffset as titleRow minus the
  // local anchor. This anchor therefore yields totalRows - viewportRows,
  // bottom-aligning the complete short document immediately above Request.
  const localAnchor = titleRow + viewportRows - layout.totalRows;
  return headerRows + Math.max(0, Math.min(viewportRows - 1, localAnchor));
}
