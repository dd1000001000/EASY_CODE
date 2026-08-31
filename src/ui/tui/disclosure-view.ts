import { wrapToWidth } from "../render/layout.js";
import {
  layoutVirtualDocument,
  type VirtualDisclosureNode,
  type VirtualDocumentLine,
  type VirtualDocumentLinePart,
  type VirtualDocumentNode,
} from "./virtual-document.js";

export type DisclosureViewTargetKind = VirtualDisclosureNode["kind"];

export interface DisclosureViewTarget {
  readonly id: string;
  readonly kind: DisclosureViewTargetKind;
}

export interface CreateDisclosureViewOptions {
  readonly nodes: readonly VirtualDocumentNode[];
  readonly target: DisclosureViewTarget;
  readonly columns: number;
  readonly rows: number;
  readonly headerLines?: readonly string[];
  /** Request/composer rows. They are rendered directly below the transcript. */
  readonly composerLines?: readonly string[];
  /** Status rows. They are rendered at the physical bottom. */
  readonly footerLines?: readonly string[];
  /** Zero-based physical row on which the target title should remain. */
  readonly anchorScreenRow?: number;
  readonly expanded?: boolean;
  readonly preserveAnsi?: boolean;
}

/**
 * Replacement chrome for an existing disclosure view.
 *
 * Omitted fields retain their current value. Supplying an empty array clears
 * that region. The update is immutable and reflows wrapped chrome using the
 * view's current dimensions.
 */
export interface UpdateDisclosureViewChromeOptions {
  readonly headerLines?: readonly string[];
  readonly composerLines?: readonly string[];
  readonly footerLines?: readonly string[];
}

export interface DisclosureViewState {
  readonly nodes: readonly VirtualDocumentNode[];
  readonly target: DisclosureViewTarget;
  readonly targetExpanded: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly headerLines: readonly string[];
  readonly composerLines: readonly string[];
  readonly footerLines: readonly string[];
  readonly anchorScreenRow: number;
  /** May be negative to keep a title anchored near the top of the document. */
  readonly scrollOffset: number;
  readonly followTail: boolean;
  readonly preserveAnsi: boolean;
}

export type DisclosureViewFrameRegion =
  | "header"
  | "transcript"
  | "composer"
  | "footer";

export type DisclosureViewFramePart =
  | VirtualDocumentLinePart
  | "chrome"
  | "blank";

/** Metadata for one physical screen row. */
export interface DisclosureViewFrameRow {
  readonly screenRow: number;
  readonly region: DisclosureViewFrameRegion;
  readonly part: DisclosureViewFramePart;
  readonly text: string;
  readonly chromeRow?: number;
  readonly documentRow?: number;
  readonly nodeId?: string;
  readonly nodeKind?: VirtualDocumentNode["kind"];
  readonly nodeRow?: number;
  readonly partRow?: number;
  readonly targetTitle: boolean;
}

export interface DisclosureViewViewportSnapshot {
  readonly transcriptStartRow: number;
  readonly viewportRows: number;
  readonly scrollOffset: number;
  readonly minScrollOffset: number;
  readonly maxScrollOffset: number;
  readonly totalDocumentRows: number;
  readonly followTail: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly targetTitleScreenRow?: number;
  /** Actual document lines visible in the frame; overscroll blanks are absent. */
  readonly lines: readonly VirtualDocumentLine[];
}

export interface DisclosureViewFrame {
  readonly columns: number;
  readonly rows: readonly string[];
  readonly visibleRows: readonly DisclosureViewFrameRow[];
  readonly viewport: DisclosureViewViewportSnapshot;
}

export type DisclosureViewCommand =
  | { readonly type: "scroll-lines"; readonly lines: number }
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "scroll-start" }
  | { readonly type: "scroll-end" }
  | { readonly type: "follow-tail"; readonly enabled: boolean };

interface ChromeLayout {
  readonly header: readonly string[];
  readonly composer: readonly string[];
  readonly footer: readonly string[];
  readonly transcriptStartRow: number;
  readonly viewportRows: number;
}

interface ViewBounds {
  readonly minimum: number;
  readonly maximum: number;
  readonly anchorOffset: number;
}

/**
 * Build a disclosure-focused virtual transcript.
 *
 * Only `target` can be expanded. Every other Thinking/Adjustment node is
 * materialized as title + preview, irrespective of stale `expanded` flags in
 * the input. Complete bodies stay retained in `state.nodes`.
 */
export function createDisclosureViewState(
  options: CreateDisclosureViewOptions,
): DisclosureViewState {
  const columns = positiveInteger(options.columns, 1);
  const rows = positiveInteger(options.rows, 1);
  const nodes = cloneNodes(options.nodes);
  const target = cloneTarget(options.target);
  assertTarget(nodes, target);
  const preserveAnsi = options.preserveAnsi ?? true;
  const headerLines = cloneLines(options.headerLines);
  const composerLines = cloneLines(options.composerLines);
  const footerLines = cloneLines(options.footerLines);
  const chrome = layoutChrome(
    headerLines,
    composerLines,
    footerLines,
    columns,
    rows,
    preserveAnsi,
  );
  const anchorScreenRow = clamp(
    finiteInteger(
      options.anchorScreenRow ??
        chrome.transcriptStartRow + chrome.viewportRows - 1,
      chrome.transcriptStartRow,
    ),
    chrome.transcriptStartRow,
    chrome.transcriptStartRow + chrome.viewportRows - 1,
  );
  const state: DisclosureViewState = {
    nodes,
    target,
    targetExpanded: options.expanded ?? true,
    columns,
    rows,
    headerLines,
    composerLines,
    footerLines,
    anchorScreenRow,
    scrollOffset: 0,
    followTail: false,
    preserveAnsi,
  };
  const bounds = viewBounds(state);
  return { ...state, scrollOffset: bounds.anchorOffset };
}

/** Render a fixed-height frame without shortening transcript content. */
export function renderDisclosureView(
  state: Readonly<DisclosureViewState>,
): DisclosureViewFrame {
  validateState(state);
  const chrome = stateChrome(state);
  const layout = stateDocumentLayout(state);
  const bounds = viewBoundsFrom(state, chrome, layout);
  const scrollOffset = clamp(state.scrollOffset, bounds.minimum, bounds.maximum);
  const visibleRows: DisclosureViewFrameRow[] = [];

  appendChromeRows(visibleRows, "header", chrome.header);

  const visibleLines: VirtualDocumentLine[] = [];
  for (let localRow = 0; localRow < chrome.viewportRows; localRow += 1) {
    const screenRow = chrome.transcriptStartRow + localRow;
    const documentRow = scrollOffset + localRow;
    const line = documentRow >= 0 ? layout.lines[documentRow] : undefined;
    if (!line) {
      visibleRows.push({
        screenRow,
        region: "transcript",
        part: "blank",
        text: "",
        targetTitle: false,
      });
      continue;
    }
    visibleLines.push(line);
    visibleRows.push({
      screenRow,
      region: "transcript",
      part: line.part,
      text: line.text,
      documentRow: line.documentRow,
      nodeId: line.nodeId,
      nodeKind: line.nodeKind,
      nodeRow: line.nodeRow,
      partRow: line.partRow,
      targetTitle: line.nodeId === state.target.id && line.part === "title",
    });
  }

  appendChromeRows(visibleRows, "composer", chrome.composer);
  appendChromeRows(visibleRows, "footer", chrome.footer);
  if (visibleRows.length !== state.rows) {
    throw new Error(
      `Disclosure frame invariant failed: expected ${state.rows} rows, got ${visibleRows.length}.`,
    );
  }

  const title = visibleRows.find((row) => row.targetTitle);
  const atStart = scrollOffset === bounds.minimum;
  const atEnd = scrollOffset === bounds.maximum;
  return {
    columns: state.columns,
    rows: visibleRows.map((row) => row.text),
    visibleRows,
    viewport: {
      transcriptStartRow: chrome.transcriptStartRow,
      viewportRows: chrome.viewportRows,
      scrollOffset,
      minScrollOffset: bounds.minimum,
      maxScrollOffset: bounds.maximum,
      totalDocumentRows: layout.totalRows,
      followTail: state.followTail,
      atStart,
      atEnd,
      targetTitleScreenRow: title?.screenRow,
      lines: visibleLines,
    },
  };
}

export function resizeDisclosureView(
  state: Readonly<DisclosureViewState>,
  columns: number,
  rows: number,
): DisclosureViewState {
  const before = renderDisclosureView(state);
  const nextColumns = positiveInteger(columns, 1);
  const nextRows = positiveInteger(rows, 1);
  const provisional: DisclosureViewState = {
    ...state,
    columns: nextColumns,
    rows: nextRows,
  };
  const chrome = stateChrome(provisional);
  const oldTitleRow = before.viewport.targetTitleScreenRow;
  const nextAnchor = clamp(
    oldTitleRow ?? state.anchorScreenRow,
    chrome.transcriptStartRow,
    chrome.transcriptStartRow + chrome.viewportRows - 1,
  );
  const next = { ...provisional, anchorScreenRow: nextAnchor };
  const bounds = viewBounds(next);
  return {
    ...next,
    scrollOffset: oldTitleRow !== undefined
      ? bounds.anchorOffset
      : state.followTail
      ? bounds.maximum
      : clamp(state.scrollOffset, bounds.minimum, bounds.maximum),
  };
}

/**
 * Replace any subset of the fixed chrome surrounding the transcript.
 *
 * When the selected disclosure title is visible, it remains on the same
 * physical screen row whenever the resized transcript viewport can contain
 * that row. If chrome growth consumes that row, the title is clamped to the
 * nearest transcript row. When the title is outside the viewport, ordinary
 * scroll position (or follow-tail state) is preserved instead.
 */
export function updateDisclosureViewChrome(
  state: Readonly<DisclosureViewState>,
  updates: Readonly<UpdateDisclosureViewChromeOptions>,
): DisclosureViewState {
  const before = renderDisclosureView(state);
  const provisional: DisclosureViewState = {
    ...state,
    headerLines: updates.headerLines === undefined
      ? state.headerLines
      : cloneLines(updates.headerLines),
    composerLines: updates.composerLines === undefined
      ? state.composerLines
      : cloneLines(updates.composerLines),
    footerLines: updates.footerLines === undefined
      ? state.footerLines
      : cloneLines(updates.footerLines),
  };

  // Validate/reflow the replacement before deriving bounds. This also gives
  // callers an immediate RangeError if chrome would leave no transcript row.
  const chrome = stateChrome(provisional);
  const visibleTitleRow = before.viewport.targetTitleScreenRow;
  const anchorScreenRow = clamp(
    visibleTitleRow ?? state.anchorScreenRow,
    chrome.transcriptStartRow,
    chrome.transcriptStartRow + chrome.viewportRows - 1,
  );
  const next: DisclosureViewState = {
    ...provisional,
    anchorScreenRow,
  };
  const bounds = viewBounds(next);
  return {
    ...next,
    scrollOffset: visibleTitleRow !== undefined
      ? bounds.anchorOffset
      : state.followTail
      ? bounds.maximum
      : clamp(state.scrollOffset, bounds.minimum, bounds.maximum),
  };
}

export function replaceDisclosureViewNodes(
  state: Readonly<DisclosureViewState>,
  nodes: readonly VirtualDocumentNode[],
): DisclosureViewState {
  const before = renderDisclosureView(state);
  const nextNodes = cloneNodes(nodes);
  assertTarget(nextNodes, state.target);
  const visibleTitleRow = before.viewport.targetTitleScreenRow;
  const provisional = {
    ...state,
    nodes: nextNodes,
    anchorScreenRow: visibleTitleRow ?? state.anchorScreenRow,
  };
  const bounds = viewBounds(provisional);
  return {
    ...provisional,
    scrollOffset: visibleTitleRow !== undefined
      ? bounds.anchorOffset
      : state.followTail
      ? bounds.maximum
      : clamp(state.scrollOffset, bounds.minimum, bounds.maximum),
  };
}

export function appendDisclosureViewNode(
  state: Readonly<DisclosureViewState>,
  node: VirtualDocumentNode,
): DisclosureViewState {
  return replaceDisclosureViewNodes(state, [...state.nodes, node]);
}

/**
 * Toggle the current target or select another disclosure. The selected title
 * stays on its current physical row when visible; otherwise it uses the
 * configured anchor row. Preview and body are always mutually exclusive.
 */
export function toggleDisclosureView(
  state: Readonly<DisclosureViewState>,
  target: DisclosureViewTarget = state.target,
  expanded?: boolean,
): DisclosureViewState {
  const nextTarget = cloneTarget(target);
  assertTarget(state.nodes, nextTarget);
  const before = renderDisclosureView(state);
  const sameTarget = targetsEqual(state.target, nextTarget);
  const targetRow = before.visibleRows.find(
    (row) => row.nodeId === nextTarget.id && row.part === "title",
  )?.screenRow;
  const chrome = stateChrome(state);
  const anchorScreenRow = clamp(
    targetRow ?? state.anchorScreenRow,
    chrome.transcriptStartRow,
    chrome.transcriptStartRow + chrome.viewportRows - 1,
  );
  const provisional: DisclosureViewState = {
    ...state,
    target: nextTarget,
    targetExpanded: expanded ?? (sameTarget ? !state.targetExpanded : true),
    anchorScreenRow,
    followTail: false,
  };
  const bounds = viewBounds(provisional);
  return { ...provisional, scrollOffset: bounds.anchorOffset };
}

export function scrollDisclosureView(
  state: Readonly<DisclosureViewState>,
  lines: number,
): DisclosureViewState {
  const bounds = viewBounds(state);
  const scrollOffset = clamp(
    state.scrollOffset + finiteInteger(lines, 0),
    bounds.minimum,
    bounds.maximum,
  );
  return {
    ...state,
    scrollOffset,
    followTail: scrollOffset === bounds.maximum,
  };
}

export function scrollDisclosureViewToStart(
  state: Readonly<DisclosureViewState>,
): DisclosureViewState {
  const bounds = viewBounds(state);
  return { ...state, scrollOffset: bounds.minimum, followTail: false };
}

export function scrollDisclosureViewToEnd(
  state: Readonly<DisclosureViewState>,
): DisclosureViewState {
  const bounds = viewBounds(state);
  return { ...state, scrollOffset: bounds.maximum, followTail: true };
}

export function applyDisclosureViewCommand(
  state: Readonly<DisclosureViewState>,
  command: Readonly<DisclosureViewCommand>,
): DisclosureViewState {
  switch (command.type) {
    case "scroll-lines":
      return scrollDisclosureView(state, command.lines);
    case "page-up":
      return scrollDisclosureView(state, -Math.max(1, viewportRows(state) - 1));
    case "page-down":
      return scrollDisclosureView(state, Math.max(1, viewportRows(state) - 1));
    case "scroll-start":
      return scrollDisclosureViewToStart(state);
    case "scroll-end":
      return scrollDisclosureViewToEnd(state);
    case "follow-tail":
      return command.enabled
        ? scrollDisclosureViewToEnd(state)
        : { ...state, followTail: false };
  }
}

function materializeNodes(
  state: Readonly<DisclosureViewState>,
): readonly VirtualDocumentNode[] {
  return state.nodes.map((node) => {
    if (node.kind === "text") return { ...node };
    return {
      ...node,
      expanded: state.targetExpanded &&
        node.id === state.target.id &&
        node.kind === state.target.kind,
    };
  });
}

function stateDocumentLayout(state: Readonly<DisclosureViewState>) {
  return layoutVirtualDocument(materializeNodes(state), state.columns, {
    preserveAnsi: state.preserveAnsi,
  });
}

function stateChrome(state: Readonly<DisclosureViewState>): ChromeLayout {
  return layoutChrome(
    state.headerLines,
    state.composerLines,
    state.footerLines,
    state.columns,
    state.rows,
    state.preserveAnsi,
  );
}

function viewportRows(state: Readonly<DisclosureViewState>): number {
  return stateChrome(state).viewportRows;
}

function viewBounds(state: Readonly<DisclosureViewState>): ViewBounds {
  return viewBoundsFrom(state, stateChrome(state), stateDocumentLayout(state));
}

function viewBoundsFrom(
  state: Readonly<DisclosureViewState>,
  chrome: ChromeLayout,
  layout: ReturnType<typeof layoutVirtualDocument>,
): ViewBounds {
  const titleRow = layout.titleRows.get(state.target.id);
  if (titleRow === undefined) {
    throw new Error(`Disclosure target has no title row: ${state.target.id}`);
  }
  const localAnchor = state.anchorScreenRow - chrome.transcriptStartRow;
  const anchorOffset = titleRow - localAnchor;
  const ordinaryMaximum = Math.max(0, layout.totalRows - chrome.viewportRows);
  return {
    minimum: Math.min(0, anchorOffset),
    maximum: Math.max(ordinaryMaximum, anchorOffset),
    anchorOffset,
  };
}

function layoutChrome(
  headerLines: readonly string[],
  composerLines: readonly string[],
  footerLines: readonly string[],
  columns: number,
  rows: number,
  preserveAnsi: boolean,
): ChromeLayout {
  const header = wrapChrome(headerLines, columns, preserveAnsi);
  const composer = wrapChrome(composerLines, columns, preserveAnsi);
  const footer = wrapChrome(footerLines, columns, preserveAnsi);
  const chromeRows = header.length + composer.length + footer.length;
  if (chromeRows >= rows) {
    throw new RangeError(
      `Disclosure view requires at least one transcript row; chrome uses ${chromeRows} of ${rows} rows.`,
    );
  }
  return {
    header,
    composer,
    footer,
    transcriptStartRow: header.length,
    viewportRows: rows - chromeRows,
  };
}

function wrapChrome(
  lines: readonly string[],
  columns: number,
  preserveAnsi: boolean,
): readonly string[] {
  return lines.flatMap((line) =>
    wrapToWidth(line, columns, { preserveAnsi })
  );
}

function appendChromeRows(
  rows: DisclosureViewFrameRow[],
  region: Exclude<DisclosureViewFrameRegion, "transcript">,
  values: readonly string[],
): void {
  for (let chromeRow = 0; chromeRow < values.length; chromeRow += 1) {
    rows.push({
      screenRow: rows.length,
      region,
      part: "chrome",
      text: values[chromeRow] ?? "",
      chromeRow,
      targetTitle: false,
    });
  }
}

function validateState(state: Readonly<DisclosureViewState>): void {
  positiveInteger(state.columns, 1);
  positiveInteger(state.rows, 1);
  assertTarget(state.nodes, state.target);
  stateChrome(state);
}

function assertTarget(
  nodes: readonly VirtualDocumentNode[],
  target: DisclosureViewTarget,
): void {
  // Laying out also validates duplicate IDs.
  layoutVirtualDocument(nodes, 1, { preserveAnsi: false });
  const node = nodes.find((candidate) => candidate.id === target.id);
  if (!node || node.kind === "text" || node.kind !== target.kind) {
    throw new Error(
      `Disclosure target ${target.kind}/${target.id} does not match a transcript disclosure.`,
    );
  }
}

function cloneNodes(
  nodes: readonly VirtualDocumentNode[],
): readonly VirtualDocumentNode[] {
  return nodes.map((node) => ({ ...node }));
}

function cloneLines(lines: readonly string[] | undefined): readonly string[] {
  return Array.from(lines ?? []);
}

function cloneTarget(target: DisclosureViewTarget): DisclosureViewTarget {
  return { id: target.id, kind: target.kind };
}

function targetsEqual(
  left: DisclosureViewTarget,
  right: DisclosureViewTarget,
): boolean {
  return left.id === right.id && left.kind === right.kind;
}

function positiveInteger(value: number, fallback: number): number {
  const normalized = finiteInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
