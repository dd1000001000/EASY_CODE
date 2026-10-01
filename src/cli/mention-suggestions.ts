import type { SlashSuggestion } from "./slash-suggestions.js";

/** Most entries offered for one `@` query. */
const MAX_MENTION_SUGGESTIONS = 50;

interface MentionEntry {
  /** Workspace-relative, `/`-separated; directories end without a slash. */
  readonly path: string;
  readonly lower: string;
  readonly name: string;
  readonly directory: boolean;
  readonly depth: number;
}

/**
 * Workspace files and the directories that contain them, searchable by an
 * `@` query. Paths with whitespace are left out: an `@` reference ends at the
 * first space, so they could not be written back into the draft.
 */
export class MentionIndex {
  private entries: readonly MentionEntry[] | undefined;

  constructor(private readonly load: () => readonly string[]) {}

  private all(): readonly MentionEntry[] {
    // A workspace listing still loading reads as empty; ask again on the next keystroke.
    if (this.entries && this.entries.length > 0) return this.entries;
    const files = new Set<string>();
    const directories = new Set<string>();
    for (const raw of this.load()) {
      const path = raw
        .replace(/\\/gu, "/")
        .replace(/^\.\/+/u, "")
        .replace(/\/+$/u, "");
      if (!path || /\s/u.test(path)) continue;
      files.add(path);
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
    }
    const entry = (path: string, directory: boolean): MentionEntry => ({
      path,
      lower: path.toLowerCase(),
      name: path.slice(path.lastIndexOf("/") + 1).toLowerCase(),
      directory,
      depth: path.split("/").length,
    });
    this.entries = [
      ...[...directories].map((path) => entry(path, true)),
      ...[...files].filter((path) => !directories.has(path)).map((path) => entry(path, false)),
    ];
    return this.entries;
  }

  /** Entries for a query: a directory's children after `/`, otherwise every path containing it. */
  search(query: string): readonly MentionEntry[] {
    const normalized = query.replace(/\\/gu, "/").toLowerCase();
    const entries = this.all();
    let matches: MentionEntry[];
    if (normalized === "" || normalized.endsWith("/")) {
      const parent = normalized.replace(/\/+$/u, "");
      const depth = parent ? parent.split("/").length + 1 : 1;
      matches = entries.filter((entry) => entry.depth === depth && (!parent || entry.lower.startsWith(`${parent}/`)));
      matches.sort(
        (left, right) => Number(right.directory) - Number(left.directory) || left.lower.localeCompare(right.lower),
      );
    } else {
      const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
      const rank = (entry: MentionEntry): number =>
        entry.name.startsWith(leaf) ? 0 : entry.lower.startsWith(normalized) ? 1 : entry.name.includes(leaf) ? 2 : 3;
      matches = entries.filter((entry) => entry.lower.includes(normalized));
      matches.sort(
        (left, right) =>
          rank(left) - rank(right) ||
          left.depth - right.depth ||
          left.path.length - right.path.length ||
          left.lower.localeCompare(right.lower),
      );
    }
    return matches.slice(0, MAX_MENTION_SUGGESTIONS);
  }
}

/** The `@` reference the caret is in: its start offset and the text typed after `@`. */
function mentionAt(text: string, cursor: number): { readonly start: number; readonly query: string } | undefined {
  let start = cursor;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1;
  if (text[start] !== "@") return undefined;
  const query = text.slice(start + 1, cursor);
  return query.includes("@") ? undefined : { start, query };
}

/**
 * Menu entries for an `@file` reference being typed anywhere in the draft.
 * Choosing a directory fills in `@dir/` and keeps the menu open on its
 * contents; choosing a file completes the reference and adds a space.
 */
export function mentionSuggestions(text: string, cursor: number, index: MentionIndex): readonly SlashSuggestion[] {
  const mention = mentionAt(text, cursor);
  if (!mention) return [];
  const before = text.slice(0, mention.start);
  const after = text.slice(cursor);
  return index.search(mention.query).map((entry) => {
    const inserted = entry.directory ? `@${entry.path}/` : `@${entry.path} `;
    return {
      label: entry.directory ? `${entry.path}/` : entry.path,
      description: "",
      replacement: `${before}${inserted}${after.startsWith(" ") && !entry.directory ? after.slice(1) : after}`,
      cursor: before.length + inserted.length,
      submit: false,
    };
  });
}
