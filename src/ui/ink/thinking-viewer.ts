import chalk from "chalk";

import { truncateToWidth } from "../render/layout.js";
import { FullScreenWriter } from "../tui/full-screen-writer.js";
import type { TranscriptDocument } from "./entry-text.js";

/** Keys the viewer understands; everything else is ignored. */
const KEY_ACTIONS: readonly (readonly [string, ViewerKey])[] = [
  ["\u001B[A", "up"],
  ["\u001BOA", "up"],
  ["\u001B[B", "down"],
  ["\u001BOB", "down"],
  ["\u001B[5~", "page-up"],
  ["\u001B[6~", "page-down"],
  ["\u001B[H", "home"],
  ["\u001B[1~", "home"],
  ["\u001BOH", "home"],
  ["\u001B[F", "end"],
  ["\u001B[4~", "end"],
  ["\u001BOF", "end"],
  ["\u0003", "close"],
  ["\u0014", "close"],
  ["q", "close"],
  ["k", "up"],
  ["j", "down"],
  [" ", "page-down"],
];

type ViewerKey = "up" | "down" | "page-up" | "page-down" | "home" | "end" | "close";

/** Split one stdin chunk into viewer keys. A lone Esc closes; other escape sequences are skipped whole. */
export function parseViewerKeys(chunk: string): ViewerKey[] {
  if (chunk === "\u001B") return ["close"];
  const keys: ViewerKey[] = [];
  let index = 0;
  while (index < chunk.length) {
    const match = KEY_ACTIONS.find(([sequence]) => chunk.startsWith(sequence, index));
    if (match) {
      keys.push(match[1]);
      index += match[0].length;
      continue;
    }
    if (chunk[index] === "\u001B") {
      // Skip an unrecognized CSI/SS3 sequence so its bytes are not read as keys.
      const rest = /^\u001B(?:\[[0-9;:?]*[ -/]*[@-~]|O.|.)?/u.exec(chunk.slice(index));
      index += rest?.[0].length || 1;
      continue;
    }
    index += 1;
  }
  return keys;
}

export interface ThinkingViewerHost {
  readonly output: NodeJS.WriteStream;
  /** The transcript with the given Thinking blocks expanded, wrapped for `columns`. */
  document(expanded: ReadonlySet<number>, columns: number): TranscriptDocument;
  /** Called once after the viewer has left the alternate screen. */
  onClosed(): void;
}

/**
 * Full-screen view of the transcript with Thinking blocks expanded in place.
 *
 * The inline UI cannot change rows that are already in terminal scrollback, so
 * expanding a Thinking block opens this alternate-screen copy of the
 * transcript, positioned so the block's marker stays on the row where it was
 * clicked. Collapsing the last expanded block (Ctrl+click again, Esc, q) returns
 * to the untouched primary screen.
 */
export class ThinkingViewer {
  private readonly writer: FullScreenWriter;
  private readonly expanded = new Set<number>();
  private top = 0;
  private document: TranscriptDocument = { lines: [], markers: new Map() };
  private open = false;

  constructor(private readonly host: ThinkingViewerHost) {
    this.writer = new FullScreenWriter({ output: host.output });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Expand `id` and show it with its marker on screen row `anchorRow` (0-based) when possible. */
  show(id: number, anchorRow: number): void {
    this.expanded.add(id);
    this.relayout();
    const marker = this.document.markers.get(id) ?? 0;
    this.top = this.clampTop(marker - Math.max(0, Math.min(anchorRow, this.viewRows() - 1)));
    if (!this.open) {
      this.open = true;
      this.writer.enter();
    }
    this.paint();
  }

  /** Ctrl+click on a marker inside the viewer: expand it, or collapse it and close when none remain. */
  toggle(id: number): void {
    if (!this.open) return;
    if (!this.expanded.has(id)) {
      const before = this.document.markers.get(id);
      const row = before === undefined ? 0 : before - this.top;
      this.show(id, row >= 0 && row < this.viewRows() ? row : 0);
      return;
    }
    const before = this.document.markers.get(id) ?? 0;
    this.expanded.delete(id);
    if (this.expanded.size === 0) {
      this.close();
      return;
    }
    const row = before - this.top;
    this.relayout();
    const after = this.document.markers.get(id) ?? 0;
    this.top = this.clampTop(after - row);
    this.paint();
  }

  handleInput(chunk: string): void {
    for (const key of parseViewerKeys(chunk)) {
      if (!this.open) return;
      const page = Math.max(1, this.viewRows() - 1);
      if (key === "close") return this.close();
      if (key === "up") this.top -= 1;
      else if (key === "down") this.top += 1;
      else if (key === "page-up") this.top -= page;
      else if (key === "page-down") this.top += page;
      else if (key === "home") this.top = 0;
      else if (key === "end") this.top = Number.MAX_SAFE_INTEGER;
      this.top = this.clampTop(this.top);
    }
    this.paint();
  }

  resize(): void {
    if (!this.open) return;
    const anchor = [...this.expanded].at(-1);
    const row = anchor === undefined ? 0 : (this.document.markers.get(anchor) ?? 0) - this.top;
    this.writer.resize();
    this.relayout();
    if (anchor !== undefined) this.top = this.clampTop((this.document.markers.get(anchor) ?? 0) - row);
    this.paint();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.expanded.clear();
    this.writer.exit();
    this.host.onClosed();
  }

  private columns(): number {
    return Math.max(12, (this.host.output.columns || 80) - 1);
  }

  private viewRows(): number {
    // The last row is the key hint.
    return Math.max(1, (this.host.output.rows || 24) - 1);
  }

  private relayout(): void {
    this.document = this.host.document(this.expanded, this.columns());
  }

  private clampTop(top: number): number {
    return Math.max(0, Math.min(top, this.document.lines.length - this.viewRows()));
  }

  private paint(): void {
    if (!this.open) return;
    const rows = this.document.lines.slice(this.top, this.top + this.viewRows());
    while (rows.length < this.viewRows()) rows.push("");
    const last = Math.min(this.document.lines.length, this.top + this.viewRows());
    const hint =
      `Thinking · ↑/↓ PgUp/PgDn scroll · Ctrl+click the title or Esc to collapse · ` +
      `${last}/${this.document.lines.length}`;
    rows.push(chalk.gray(truncateToWidth(hint, this.columns(), { preserveAnsi: false })));
    this.writer.render(rows);
  }
}
