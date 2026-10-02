import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TurnDiffHunk, TurnFileDiff } from "../ui/contracts.js";

/** Diff lines kept for one file; longer changes are cut and marked truncated. */
export const MAX_TURN_FILE_DIFF_LINES = 2_000;
/** Diff lines kept for all files of one request, so a request that rewrites a whole tree stays bounded on disk. */
export const MAX_TURN_DIFF_LINES = 50_000;
const MAX_HUNKS = 2_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STORE_VERSION = 1;

function isLine(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith(" ") || value.startsWith("+") || value.startsWith("-"));
}

/** A recorded diff, or undefined when the value is not one. */
export function parseTurnDiff(value: unknown): TurnFileDiff | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { hunks, truncated } = value as { hunks?: unknown; truncated?: unknown };
  if (!Array.isArray(hunks) || hunks.length > MAX_HUNKS) return undefined;
  const parsed: TurnDiffHunk[] = [];
  let total = 0;
  for (const hunk of hunks) {
    if (hunk === null || typeof hunk !== "object") return undefined;
    const { oldStart, newStart, lines } = hunk as { oldStart?: unknown; newStart?: unknown; lines?: unknown };
    if (!Number.isInteger(oldStart) || !Number.isInteger(newStart) || !Array.isArray(lines)) return undefined;
    if (!lines.every(isLine)) return undefined;
    total += lines.length;
    if (total > MAX_TURN_FILE_DIFF_LINES) return undefined;
    parsed.push({ oldStart: oldStart as number, newStart: newStart as number, lines });
  }
  return { hunks: parsed, truncated: truncated === true };
}

/**
 * The net diff of each file a request changed, read only when the user opens
 * one. The turn summary records just the line counts, so a long list of files
 * neither grows the journal nor the page. Diffs live in the thread's own
 * directory, which is removed with the thread.
 */
export class TurnDiffStore {
  private readonly threadsRoot: string;

  constructor(dataDir: string) {
    this.threadsRoot = path.resolve(dataDir, "threads");
  }

  private file(threadId: string, turnId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(threadId) || threadId === "." || threadId === "..")
      throw new Error("Invalid thread id.");
    if (!SAFE_ID.test(turnId)) throw new Error("Invalid turn id.");
    return path.join(this.threadsRoot, threadId, "turn-diffs", `${turnId}.json`);
  }

  write(threadId: string, turnId: string, diffs: ReadonlyMap<string, TurnFileDiff>): void {
    const target = this.file(threadId, turnId);
    if (diffs.size === 0) {
      rmSync(target, { force: true });
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: STORE_VERSION, files: Object.fromEntries(diffs) }), {
      mode: 0o600,
    });
    renameSync(temporary, target);
  }

  /** The diff saved for one file of a request, or undefined when there is none. */
  read(threadId: string, turnId: string, filePath: string): TurnFileDiff | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.file(threadId, turnId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const saved = JSON.parse(raw) as { version?: unknown; files?: unknown };
    if (saved.version !== STORE_VERSION || saved.files === null || typeof saved.files !== "object") return undefined;
    const files = saved.files as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(files, filePath) ? parseTurnDiff(files[filePath]) : undefined;
  }
}
