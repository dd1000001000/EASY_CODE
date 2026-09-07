import { wrapToWidth } from "../render/layout.js";

/** A completed, non-interactive item in the virtual terminal transcript. */
export interface VirtualTextNode {
  readonly id: string;
  readonly kind: "text";
  /** Retained verbatim. Terminal sanitization is applied only while laying out. */
  readonly text: string;
}

interface VirtualDisclosureNodeFields {
  readonly id: string;
  /** Title is always present and is the stable anchor used while toggling. */
  readonly title: string;
  /** Compact content rendered while the disclosure is closed. */
  readonly preview: string;
  /** Complete content rendered while the disclosure is open. */
  readonly body: string;
  readonly expanded: boolean;
}

export interface VirtualThinkingNode extends VirtualDisclosureNodeFields {
  readonly kind: "thinking";
}

export interface VirtualAdjustmentNode extends VirtualDisclosureNodeFields {
  readonly kind: "adjustment";
}

export type VirtualDisclosureNode =
  | VirtualThinkingNode
  | VirtualAdjustmentNode;

export type VirtualDocumentNode = VirtualTextNode | VirtualDisclosureNode;

// Only snapshots owned by this module are memoized. Callers may still pass
// mutable arrays/objects to the public layout API without getting stale rows.
const snapshots = new WeakSet<readonly VirtualDocumentNode[]>();
const ownedNodes = new WeakSet<VirtualDocumentNode>();
// Keep only the latest width/style variant; resizing must not grow a global
// text cache. Weak keys release layouts when their transcript is discarded.
const documentLayouts = new WeakMap<readonly VirtualDocumentNode[], {
  columns: number;
  preserveAnsi: boolean;
  layout: VirtualDocumentLayout;
}>();
const nodeLayouts = new WeakMap<VirtualDocumentNode, {
  columns: number;
  preserveAnsi: boolean;
  parts: Map<VirtualDocumentLinePart, readonly string[]>;
}>();

export function isVirtualDocumentSnapshot(nodes: readonly VirtualDocumentNode[]): boolean {
  return snapshots.has(nodes);
}

/** Copy external input, retaining unchanged immutable nodes across appends. */
export function snapshotVirtualDocumentNodes(
  nodes: readonly VirtualDocumentNode[],
  previous: readonly VirtualDocumentNode[] = [],
): readonly VirtualDocumentNode[] {
  if (snapshots.has(nodes)) return nodes;
  validateVirtualDocumentNodes(nodes);
  const byId = new Map(previous.map((node) => [node.id, node]));
  const result = nodes.map((node) => {
    const old = byId.get(node.id);
    if (old && ownedNodes.has(old) && sameNode(old, node)) return old;
    if (ownedNodes.has(node)) return node;
    const copy = Object.freeze({ ...node });
    ownedNodes.add(copy);
    return copy;
  });
  if (snapshots.has(previous) && result.length === previous.length &&
      result.every((node, index) => node === previous[index])) return previous;
  Object.freeze(result);
  snapshots.add(result);
  return result;
}

function sameNode(left: VirtualDocumentNode, right: VirtualDocumentNode): boolean {
  if (left.id !== right.id || left.kind !== right.kind) return false;
  if (left.kind === "text") return right.kind === "text" && left.text === right.text;
  return right.kind !== "text" && left.title === right.title &&
    left.preview === right.preview && left.body === right.body && left.expanded === right.expanded;
}

export type VirtualDocumentLinePart =
  | "text"
  | "title"
  | "preview"
  | "body";

/** One terminal row in the fully laid-out virtual document. */
export interface VirtualDocumentLine {
  readonly documentRow: number;
  readonly nodeId: string;
  readonly nodeKind: VirtualDocumentNode["kind"];
  readonly part: VirtualDocumentLinePart;
  /** Zero-based row inside the node. */
  readonly nodeRow: number;
  /** Zero-based row inside `part`. */
  readonly partRow: number;
  readonly text: string;
}

export interface VirtualDocumentLayout {
  readonly columns: number;
  readonly lines: readonly VirtualDocumentLine[];
  readonly totalRows: number;
  /** First visual row occupied by each node. */
  readonly nodeRows: ReadonlyMap<string, number>;
  /** First visual title row for Thinking and Adjustment nodes. */
  readonly titleRows: ReadonlyMap<string, number>;
}

export interface VirtualViewportState {
  readonly nodes: readonly VirtualDocumentNode[];
  readonly columns: number;
  readonly viewportRows: number;
  /** Zero-based first document row visible in the viewport. */
  readonly scrollOffset: number;
  /** Keep the viewport at the document tail when content is replaced/appended. */
  readonly followTail: boolean;
  /** Preserve safe SGR styles while wrapping. Defaults to true. */
  readonly preserveAnsi: boolean;
}

export interface CreateVirtualViewportOptions {
  readonly nodes?: readonly VirtualDocumentNode[];
  readonly columns: number;
  readonly viewportRows: number;
  readonly scrollOffset?: number;
  readonly followTail?: boolean;
  readonly preserveAnsi?: boolean;
}

export interface VirtualViewportSnapshot {
  readonly columns: number;
  readonly viewportRows: number;
  readonly scrollOffset: number;
  readonly maxScrollOffset: number;
  readonly totalRows: number;
  readonly followTail: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  /** Only actual document rows. No hidden/truncated/pagination markers. */
  readonly lines: readonly VirtualDocumentLine[];
}

export type VirtualViewportCommand =
  | { readonly type: "scroll-lines"; readonly lines: number }
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "scroll-start" }
  | { readonly type: "scroll-end" }
  | { readonly type: "follow-tail"; readonly enabled: boolean };

/**
 * Lay out the complete virtual document. This function never shortens content:
 * terminal height is deliberately absent from its inputs.
 */
export function layoutVirtualDocument(
  nodes: readonly VirtualDocumentNode[],
  columns: number,
  options: { readonly preserveAnsi?: boolean } = {},
): VirtualDocumentLayout {
  const normalizedColumns = positiveInteger(columns, 1);
  const preserveAnsi = options.preserveAnsi ?? true;
  const cached = documentLayouts.get(nodes);
  if (cached?.columns === normalizedColumns && cached.preserveAnsi === preserveAnsi) {
    return cached.layout;
  }
  validateVirtualDocumentNodes(nodes);
  const lines: VirtualDocumentLine[] = [];
  const nodeRows = new Map<string, number>();
  const titleRows = new Map<string, number>();

  for (const node of nodes) {
    let nodeCache = nodeLayouts.get(node);
    if (!nodeCache || nodeCache.columns !== normalizedColumns || nodeCache.preserveAnsi !== preserveAnsi) {
      nodeCache = { columns: normalizedColumns, preserveAnsi, parts: new Map() };
      if (ownedNodes.has(node)) nodeLayouts.set(node, nodeCache);
    }
    nodeRows.set(node.id, lines.length);
    let nodeRow = 0;

    const appendPart = (
      part: VirtualDocumentLinePart,
      value: string,
    ): void => {
      let wrapped = nodeCache.parts.get(part);
      if (!wrapped) {
        wrapped = wrapToWidth(value, normalizedColumns, { preserveAnsi });
        nodeCache.parts.set(part, wrapped);
      }
      for (let partRow = 0; partRow < wrapped.length; partRow += 1) {
        lines.push({
          documentRow: lines.length,
          nodeId: node.id,
          nodeKind: node.kind,
          part,
          nodeRow,
          partRow,
          text: wrapped[partRow] ?? "",
        });
        nodeRow += 1;
      }
    };

    if (node.kind === "text") {
      appendPart("text", node.text);
      continue;
    }

    titleRows.set(node.id, lines.length);
    appendPart("title", node.title);
    appendPart(node.expanded ? "body" : "preview", node.expanded
      ? node.body
      : node.preview);
  }

  const layout: VirtualDocumentLayout = {
    columns: normalizedColumns,
    lines,
    totalRows: lines.length,
    nodeRows,
    titleRows,
  };
  if (snapshots.has(nodes)) {
    documentLayouts.set(nodes, { columns: normalizedColumns, preserveAnsi, layout });
  }
  return layout;
}

export function createVirtualViewportState(
  options: CreateVirtualViewportOptions,
): VirtualViewportState {
  const nodes = cloneNodes(options.nodes ?? []);
  const columns = positiveInteger(options.columns, 1);
  const viewportRows = positiveInteger(options.viewportRows, 1);
  const preserveAnsi = options.preserveAnsi ?? true;
  const layout = layoutVirtualDocument(nodes, columns, { preserveAnsi });
  const maximum = maxScrollOffset(layout.totalRows, viewportRows);
  const followTail = options.followTail ?? options.scrollOffset === undefined;
  const requestedOffset = nonNegativeInteger(options.scrollOffset ?? 0);

  return {
    nodes,
    columns,
    viewportRows,
    scrollOffset: followTail ? maximum : clamp(requestedOffset, 0, maximum),
    followTail,
    preserveAnsi,
  };
}

/** Render one continuous window over the full document. */
export function renderVirtualViewport(
  state: Readonly<VirtualViewportState>,
): VirtualViewportSnapshot {
  const layout = stateLayout(state);
  const maximum = maxScrollOffset(layout.totalRows, state.viewportRows);
  const offset = state.followTail
    ? maximum
    : clamp(nonNegativeInteger(state.scrollOffset), 0, maximum);

  return {
    columns: state.columns,
    viewportRows: state.viewportRows,
    scrollOffset: offset,
    maxScrollOffset: maximum,
    totalRows: layout.totalRows,
    followTail: state.followTail,
    atStart: offset === 0,
    atEnd: offset === maximum,
    lines: layout.lines.slice(offset, offset + state.viewportRows),
  };
}

/**
 * Replace all nodes, following new output only when follow-tail is active.
 * When the user has scrolled away, their numeric viewport position is kept.
 */
export function replaceVirtualDocumentNodes(
  state: Readonly<VirtualViewportState>,
  nodes: readonly VirtualDocumentNode[],
): VirtualViewportState {
  const nextNodes = snapshotVirtualDocumentNodes(nodes, state.nodes);
  const layout = layoutVirtualDocument(nextNodes, state.columns, {
    preserveAnsi: state.preserveAnsi,
  });
  const maximum = maxScrollOffset(layout.totalRows, state.viewportRows);
  return {
    ...state,
    nodes: nextNodes,
    scrollOffset: state.followTail
      ? maximum
      : clamp(state.scrollOffset, 0, maximum),
  };
}

export function appendVirtualDocumentNode(
  state: Readonly<VirtualViewportState>,
  node: VirtualDocumentNode,
): VirtualViewportState {
  return replaceVirtualDocumentNodes(state, [...state.nodes, node]);
}

/**
 * Resize and rewrap the document. Tail-following remains exact; otherwise the
 * prior first visible node is used as a best-effort logical anchor.
 */
export function resizeVirtualViewport(
  state: Readonly<VirtualViewportState>,
  columns: number,
  viewportRows: number,
): VirtualViewportState {
  const nextColumns = positiveInteger(columns, 1);
  const nextViewportRows = positiveInteger(viewportRows, 1);
  const before = stateLayout(state);
  const topLine = before.lines[state.scrollOffset];
  const after = layoutVirtualDocument(state.nodes, nextColumns, {
    preserveAnsi: state.preserveAnsi,
  });
  const maximum = maxScrollOffset(after.totalRows, nextViewportRows);
  let nextOffset = state.scrollOffset;

  if (state.followTail) {
    nextOffset = maximum;
  } else if (topLine) {
    const nodeStart = after.nodeRows.get(topLine.nodeId);
    if (nodeStart !== undefined) {
      nextOffset = nodeStart + topLine.nodeRow;
    }
    nextOffset = clamp(nextOffset, 0, maximum);
  }

  return {
    ...state,
    columns: nextColumns,
    viewportRows: nextViewportRows,
    scrollOffset: nextOffset,
  };
}

/**
 * Expand/collapse Thinking or Adjustment in place. If its title is currently
 * visible, the title remains on the same screen row whenever document bounds
 * allow it. The preview and body are mutually exclusive in the layout.
 */
export function toggleVirtualDisclosure(
  state: Readonly<VirtualViewportState>,
  nodeId: string,
  expanded?: boolean,
): VirtualViewportState {
  const index = state.nodes.findIndex((node) => node.id === nodeId);
  const current = state.nodes[index];
  if (!current || current.kind === "text") return state;

  const nextExpanded = expanded ?? !current.expanded;
  if (nextExpanded === current.expanded) return state;

  const before = stateLayout(state);
  const beforeMaximum = maxScrollOffset(before.totalRows, state.viewportRows);
  const beforeOffset = state.followTail
    ? beforeMaximum
    : clamp(state.scrollOffset, 0, beforeMaximum);
  const titleRowBefore = before.titleRows.get(nodeId);
  const titleScreenRow = titleRowBefore === undefined
    ? undefined
    : titleRowBefore - beforeOffset;
  const titleIsVisible = titleScreenRow !== undefined &&
    titleScreenRow >= 0 &&
    titleScreenRow < state.viewportRows;

  const replacement: VirtualDisclosureNode = { ...current, expanded: nextExpanded };
  const nodes = snapshotVirtualDocumentNodes(state.nodes.map((node, nodeIndex) =>
    nodeIndex === index ? replacement : node
  ), state.nodes);
  const after = layoutVirtualDocument(nodes, state.columns, {
    preserveAnsi: state.preserveAnsi,
  });
  const maximum = maxScrollOffset(after.totalRows, state.viewportRows);
  let nextOffset = clamp(beforeOffset, 0, maximum);

  if (titleIsVisible && titleScreenRow !== undefined) {
    const titleRowAfter = after.titleRows.get(nodeId);
    if (titleRowAfter !== undefined) {
      nextOffset = clamp(titleRowAfter - titleScreenRow, 0, maximum);
    }
  }

  return {
    ...state,
    nodes,
    scrollOffset: nextOffset,
    // Toggling is an explicit inspection action. Do not let the next streamed
    // row immediately pull an anchored title away from the user.
    followTail: false,
  };
}

export function scrollVirtualViewport(
  state: Readonly<VirtualViewportState>,
  lines: number,
): VirtualViewportState {
  const layout = stateLayout(state);
  const maximum = maxScrollOffset(layout.totalRows, state.viewportRows);
  const current = state.followTail ? maximum : state.scrollOffset;
  const delta = finiteInteger(lines, 0);
  const scrollOffset = clamp(current + delta, 0, maximum);
  return {
    ...state,
    scrollOffset,
    followTail: scrollOffset === maximum,
  };
}

/** Page movement retains one context row between adjacent screens. */
export function pageUpVirtualViewport(
  state: Readonly<VirtualViewportState>,
): VirtualViewportState {
  return scrollVirtualViewport(state, -pageStep(state.viewportRows));
}

/** Page movement retains one context row between adjacent screens. */
export function pageDownVirtualViewport(
  state: Readonly<VirtualViewportState>,
): VirtualViewportState {
  return scrollVirtualViewport(state, pageStep(state.viewportRows));
}

export function scrollVirtualViewportToStart(
  state: Readonly<VirtualViewportState>,
): VirtualViewportState {
  return { ...state, scrollOffset: 0, followTail: false };
}

export function scrollVirtualViewportToEnd(
  state: Readonly<VirtualViewportState>,
): VirtualViewportState {
  const layout = stateLayout(state);
  return {
    ...state,
    scrollOffset: maxScrollOffset(layout.totalRows, state.viewportRows),
    followTail: true,
  };
}

export function setVirtualViewportFollowTail(
  state: Readonly<VirtualViewportState>,
  enabled: boolean,
): VirtualViewportState {
  return enabled ? scrollVirtualViewportToEnd(state) : {
    ...state,
    followTail: false,
  };
}

export function applyVirtualViewportCommand(
  state: Readonly<VirtualViewportState>,
  command: Readonly<VirtualViewportCommand>,
): VirtualViewportState {
  switch (command.type) {
    case "scroll-lines":
      return scrollVirtualViewport(state, command.lines);
    case "page-up":
      return pageUpVirtualViewport(state);
    case "page-down":
      return pageDownVirtualViewport(state);
    case "scroll-start":
      return scrollVirtualViewportToStart(state);
    case "scroll-end":
      return scrollVirtualViewportToEnd(state);
    case "follow-tail":
      return setVirtualViewportFollowTail(state, command.enabled);
  }
}

function stateLayout(state: Readonly<VirtualViewportState>): VirtualDocumentLayout {
  return layoutVirtualDocument(state.nodes, state.columns, {
    preserveAnsi: state.preserveAnsi,
  });
}

function cloneNodes(
  nodes: readonly VirtualDocumentNode[],
): readonly VirtualDocumentNode[] {
  return snapshotVirtualDocumentNodes(nodes);
}

export function validateVirtualDocumentNodes(nodes: readonly VirtualDocumentNode[]): void {
  if (snapshots.has(nodes)) return;
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id) throw new Error("Virtual document node IDs cannot be empty.");
    if (ids.has(node.id)) {
      throw new Error(`Duplicate virtual document node ID: ${node.id}`);
    }
    ids.add(node.id);
  }
}

function pageStep(viewportRows: number): number {
  return Math.max(1, positiveInteger(viewportRows, 1) - 1);
}

function maxScrollOffset(totalRows: number, viewportRows: number): number {
  return Math.max(0, totalRows - viewportRows);
}

function positiveInteger(value: number, fallback: number): number {
  const normalized = finiteInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, finiteInteger(value, 0));
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
