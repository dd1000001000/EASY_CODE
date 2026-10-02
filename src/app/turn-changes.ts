import { structuredPatch } from "diff";
import type { FileChangeRecord, FileDiffPresentation } from "../core/types.js";
import type { TurnChangedFile, TurnDiffHunk, TurnFileDiff, TurnLineCounts } from "../ui/contracts.js";

/** Larger edits get no line counts; diffing them would delay the end of the request. */
const MAX_DIFF_CHARS = 2_000_000;
const MAX_EDIT_LENGTH = 20_000;
/** Diff lines kept for one file, and for all files of one request, in the saved summary. */
const MAX_FILE_DIFF_LINES = 400;
const MAX_TURN_DIFF_LINES = 3_000;
/** Longer lines (minified code, data) are cut; the counts are unaffected. */
const MAX_DIFF_LINE_CHARS = 400;

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

/** Editor swap and backup files, atomic-write leftovers, Office locks and OS folder metadata. */
const TEMPORARY_FILE =
  /^(?:.*\.(?:tmp|temp)(?:-\w+)?|.*\.sw[a-p]|.*~|~\$.*|\.#.*|#.*#|\.ds_store|thumbs\.db|desktop\.ini)$/iu;

/**
 * Files the summary leaves out: anything under a folder whose name starts with
 * a dot (tool caches, VCS and editor state, runtime scratch) or `__pycache__`,
 * and temporary files. The workspace change set still records them; only the
 * summary shown to the user skips them.
 */
function hiddenFromSummary(path: string): boolean {
  const segments = normalizePath(path).split("/");
  const name = segments.pop() ?? "";
  return segments.some((segment) => segment.startsWith(".") || segment === "__pycache__") || TEMPORARY_FILE.test(name);
}

export interface TurnFileChange {
  readonly lines: TurnLineCounts;
  /** Every hunk, uncapped; the summary trims it. */
  readonly hunks: readonly TurnDiffHunk[];
}

/**
 * The text of each file a request changed through the file tools: the
 * content before its first edit and after its latest one, so the request's
 * net change can be taken when it finishes.
 */
export class TurnFileText {
  private readonly files = new Map<string, { before: string; after: string }>();

  clear(): void {
    this.files.clear();
  }

  record(presentation: Readonly<FileDiffPresentation>): void {
    const path = normalizePath(presentation.path);
    const known = this.files.get(path);
    if (known) known.after = presentation.after;
    else this.files.set(path, { before: presentation.before, after: presentation.after });
  }

  /** The net change from the first text to the latest, if the file was edited and is small enough. */
  change(path: string): TurnFileChange | undefined {
    const key = normalizePath(path);
    const text = this.files.get(key);
    if (!text || text.before.length + text.after.length > MAX_DIFF_CHARS) return undefined;
    let patch: ReturnType<typeof structuredPatch> | undefined;
    try {
      patch = structuredPatch(key, key, text.before, text.after, "", "", {
        context: 3,
        maxEditLength: MAX_EDIT_LENGTH,
      }) as ReturnType<typeof structuredPatch> | undefined;
    } catch {
      return undefined;
    }
    if (!patch) return undefined;
    let added = 0;
    let removed = 0;
    const hunks = patch.hunks.map((hunk) => {
      // "\ No newline at end of file" markers are not lines of the file.
      const lines = hunk.lines.filter((line) => !line.startsWith("\\"));
      for (const line of lines) {
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
      return { oldStart: hunk.oldStart, newStart: hunk.newStart, lines };
    });
    return { lines: { added, removed }, hunks };
  }
}

const fileTexts = new WeakMap<object, TurnFileText>();

/** The collector of one workspace; file-tool results and the turn summary meet through it. */
export function turnFileText(workspace: object): TurnFileText {
  let text = fileTexts.get(workspace);
  if (!text) fileTexts.set(workspace, (text = new TurnFileText()));
  return text;
}

/** Hunks up to `budget` lines, cutting long lines; the budget left goes to later files. */
function trimDiff(hunks: readonly TurnDiffHunk[], budget: number): { diff: TurnFileDiff; used: number } {
  const limit = Math.min(budget, MAX_FILE_DIFF_LINES);
  const kept: TurnDiffHunk[] = [];
  let used = 0;
  let truncated = false;
  for (const hunk of hunks) {
    if (used >= limit) {
      truncated = true;
      break;
    }
    const lines = hunk.lines
      .slice(0, limit - used)
      .map((line) => (line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…` : line));
    if (lines.length < hunk.lines.length) truncated = true;
    kept.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines });
    used += lines.length;
  }
  return { diff: { hunks: kept, truncated }, used };
}

/** Did this change bring the file into existence (a file tool's create, or a command's new file)? */
function createsFile(change: Readonly<FileChangeRecord>): boolean {
  return change.operation === "create" || (change.operation === "generated" && change.beforeHash === undefined);
}

function deletesFile(change: Readonly<FileChangeRecord>): boolean {
  return change.operation === "delete" || change.operation === "deleted_by_command";
}

/**
 * The files one request left changed, each once, in first-touched order: new
 * when the request's first change created it, deleted when its last change
 * removed it. A file both created and removed within the request is left out,
 * as are hidden-folder and temporary files and any whose path no longer
 * resolves inside the workspace. Line counts
 * and diffs come from the file tools' text; a file a command also changed has
 * neither, since its text was not seen.
 */
export function turnChangedFiles(
  changes: readonly Readonly<FileChangeRecord>[],
  resolve: (relative: string) => string,
  text?: TurnFileText,
): TurnChangedFile[] {
  const first = new Map<string, Readonly<FileChangeRecord>>();
  const last = new Map<string, Readonly<FileChangeRecord>>();
  const byCommand = new Set<string>();
  for (const change of changes) {
    if (change.status === "failed" || change.status === "policy_violation" || change.status === "conflict") continue;
    if (hiddenFromSummary(change.path)) continue;
    if (!first.has(change.path)) first.set(change.path, change);
    last.set(change.path, change);
    if (change.source === "command") byCommand.add(change.path);
  }
  const files: TurnChangedFile[] = [];
  let budget = MAX_TURN_DIFF_LINES;
  for (const [path, change] of last) {
    const created = createsFile(first.get(path)!);
    const deleted = deletesFile(change);
    if (created && deleted) continue;
    let absolutePath: string;
    try {
      absolutePath = resolve(path);
    } catch {
      continue;
    }
    const net = byCommand.has(path) ? undefined : text?.change(path);
    let diff: TurnFileDiff | undefined;
    if (net && budget > 0) {
      const trimmed = trimDiff(net.hunks, budget);
      diff = trimmed.diff;
      budget -= trimmed.used;
    }
    files.push({
      path,
      absolutePath,
      change: deleted ? "deleted" : created ? "created" : "modified",
      ...(net ? { lines: net.lines } : {}),
      ...(diff ? { diff } : {}),
    });
  }
  return files;
}
