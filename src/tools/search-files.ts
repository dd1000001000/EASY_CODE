import { lstat, open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { estimatedTokens } from "../context/token-budget.js";
import { sha256 } from "../utils/hash.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { resolveExistingFileToolTarget, type FileToolTarget } from "./file-access.js";
import { documentToolSchema } from "./metadata.js";

export const searchFilesInputSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  glob: z.string().min(1).max(256).optional(),
  query: z.string().min(1).max(512).optional(),
  caseSensitive: z.boolean().optional(),
  mode: z.enum(["search", "list"]).optional(),
  maxDepth: z.number().int().min(1).max(256).optional(),
}).strict();
const ignored = new Set([".git", ".easycode", ".easy-code-srt-runtime", "node_modules", "dist", "dist-test",
  "build", "coverage", "vendor", ".venv", "venv", "__pycache__", ".next", "target",
  "site-packages", "dist-packages", ".cache", "cache", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);

/** Bounded flat brace alternatives; unsupported syntax must not look like an empty search. */
function patterns(glob: string): string[] {
  if (/[\[\]]/u.test(glob)) throw new Error("glob character classes are unsupported; use *, **, ? or flat {a,b} alternatives");
  let expanded = [glob];
  while (expanded.some((value) => /[{}]/u.test(value))) {
    const next: string[] = [];
    for (const value of expanded) {
      if (!/[{}]/u.test(value)) { next.push(value); continue; }
      const match = /\{([^{}]+)\}/u.exec(value);
      if (!match || /[{}]/u.test(value.slice(0, match.index))) throw new Error("glob requires balanced, non-nested {a,b} alternatives");
      const choices = match[1]!.split(",");
      if (choices.length < 2 || choices.some((choice) => !choice)) throw new Error("glob braces require non-empty comma-separated alternatives");
      for (const choice of choices) next.push(value.slice(0, match.index) + choice + value.slice(match.index + match[0].length));
      if (next.length > 32) throw new Error("glob supports at most 32 expanded alternatives; narrow the pattern");
    }
    if (next.length > 32) throw new Error("glob supports at most 32 expanded alternatives; narrow the pattern");
    expanded = next;
  }
  return expanded;
}

/** Small bounded glob language: *, ** and ?. No model-controlled regular expressions. */
function filePattern(glob: string): { test: (text: string) => boolean } {
  if (glob.includes("\\") || glob.split("/").includes("..") || glob.startsWith("/")) {
    throw new Error("glob must be a relative forward-slash pattern");
  }
  const parts: string[] = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") { i += 1; parts.push("**/"); }
      else parts.push("**");
    } else parts.push(c);
  }
  // Dynamic programming avoids pathological regex backtracking from globs.
  return { test: (text) => {
    let previous = new Uint8Array(text.length + 1); previous[0] = 1;
    for (const part of parts) {
      const next = new Uint8Array(text.length + 1);
      let reached = false;
      for (let j = 0; j <= text.length; j += 1) {
        if (part === "*" || part === "**") {
          next[j] = previous[j]! || (j > 0 && (part === "**" || text[j - 1] !== "/") ? next[j - 1]! : 0);
        } else if (part === "**/") {
          if (j > 0 && previous[j - 1]) reached = true;
          next[j] = previous[j]! || (j > 0 && text[j - 1] === "/" && reached ? 1 : 0);
        } else if (j > 0 && previous[j - 1] && (part === "?" ? text[j - 1] !== "/" : text[j - 1] === part)) next[j] = 1;
      }
      previous = next;
    }
    return previous[text.length] === 1;
  } };
}

export class SearchFilesTool implements AgentTool {
  readonly name = "search_files" as const;
  readonly mutating = false;
  readonly inputSchema = searchFilesInputSchema;
  readonly definition: ToolDefinition = { type: "function", function: { name: this.name, strict: true,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false, properties: {
      path: { type: "string" }, glob: { type: "string" }, query: { type: "string" }, caseSensitive: { type: "boolean" },
      mode: { type: "string", enum: ["search", "list"] }, maxDepth: { type: "integer", minimum: 1, maximum: 256 },
    }, required: [] }) } };
  constructor(private readonly workspace: WorkspaceManager) {}

  async execute(input: unknown, context: ToolContext) {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const request = this.inputSchema.parse(input);
      const limits = context.limits ?? DEFAULT_RUNTIME_LIMITS;
      const tokens = Math.min(limits.searchMaxResultTokens, context.resultTokenBudget ?? limits.searchMaxResultTokens);
      const matchers = request.glob ? patterns(request.glob).map(filePattern) : undefined;
      const mode = request.mode ?? "search";
      if (mode === "list" && request.query) throw new Error("mode list returns directory entries; omit query or use mode search for file contents");
      const maxDepth = Math.min(request.maxDepth ?? (mode === "list" ? 1 : limits.searchMaxDepth), limits.searchMaxDepth);
      const matches: object[] = [];
      const omissions = { defaultExcluded: 0, symlinks: 0, binary: 0, oversized: 0, unreadable: 0, depthLimited: 0 };
      let entries = 0, bytes = 0, files = 0, used = 512, usedChars = 2048;
      let stopped: string | undefined;
      const check = () => {
        context.signal?.throwIfAborted();
        if (context.commandExecutionMode === "unrestricted" && !(context.isUnrestrictedHostAccessActive?.() ?? true)) {
          throw new Error("Unrestricted host access was revoked during search");
        }
      };
      const rootInput = request.path ?? ".";
      const root: FileToolTarget = rootInput === "." ? { absolutePath: this.workspace.root, displayPath: ".",
        versionKey: this.workspace.root, workspaceRelative: "." }
        : await resolveExistingFileToolTarget(this.workspace, context, rootInput, { allowFinalSymlink: false });
      const push = (hit: object) => {
        const encoded = JSON.stringify(hit);
        const cost = estimatedTokens(encoded) + 4;
        if (used + cost > tokens || usedChars + encoded.length + 2 > (context.resultCharBudget ?? Infinity)) {
          stopped = "result_budget"; return false;
        }
        if (matches.length >= limits.searchMaxMatches) { stopped = "match_limit"; return false; }
        matches.push(hit); used += cost; usedChars += encoded.length + 2; return true;
      };
      const scan = async (target: FileToolTarget) => {
        check();
        const relative = path.relative(root.absolutePath, target.absolutePath).split(path.sep).join("/") || path.basename(target.absolutePath);
        if (matchers && !matchers.some((matcher) => matcher.test(request.glob!.includes("/") ? relative : path.basename(relative)))) return;
        files += 1;
        if (!request.query) { push({ path: target.displayPath, ...(mode === "list" ? { kind: "file" } : {}) }); return; }
        const handle = await open(target.absolutePath, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile()) { omissions.unreadable += 1; return; }
          if (info.size > limits.searchMaxFileBytes) { omissions.oversized += 1; return; }
          if (bytes + info.size + 1 > limits.searchMaxBytes) { stopped = "scan_byte_budget"; return; }
          const buffer = Buffer.alloc(info.size + 1);
          let count = 0;
          while (count < buffer.length) {
            check();
            const read = await handle.read(buffer, count, buffer.length - count, null);
            if (read.bytesRead === 0) break;
            count += read.bytesRead;
          }
          bytes += count;
          check();
          if (count > info.size) { omissions.oversized += 1; return; }
          const content = buffer.subarray(0, count);
          if (content.includes(0)) { omissions.binary += 1; return; }
          const lines = content.toString("utf8").split(/\r\n|\n|\r/u);
          const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
          for (let index = 0; index < lines.length && !stopped; index += 1) {
            const text = request.caseSensitive ? lines[index]! : lines[index]!.toLowerCase();
            if (!text.includes(needle)) continue;
            const start = Math.max(0, index - limits.searchContextLines);
            const end = Math.min(lines.length, index + limits.searchContextLines + 1);
            // Search locates content; it never grants read-before-write authorization.
            push({ path: target.displayPath, line: index + 1, startLine: start + 1,
              endLine: end, content: lines.slice(start, end).join("\n") });
          }
        } finally { await handle.close(); }
      };
      const queue: Array<{ target: FileToolTarget; depth: number }> = [];
      const walk = async (directory: FileToolTarget, depth: number): Promise<void> => {
        const stream = await opendir(directory.absolutePath);
        for await (const entry of stream) {
          check();
          if (stopped) break;
          if (++entries > limits.searchMaxEntries) { stopped = "entry_limit"; break; }
          const excluded = entry.isDirectory() && ignored.has(entry.name.toLowerCase());
          if (excluded) {
            omissions.defaultExcluded += 1;
            // Listing may show ordinary excluded directories without entering them; never expose control paths.
            if (mode !== "list" || [".git", ".easycode", ".easy-code-srt-runtime"].includes(entry.name.toLowerCase())) continue;
          }
          const filename = directory.workspaceRelative
            ? path.posix.join(directory.displayPath, entry.name) : path.join(directory.absolutePath, entry.name);
          try {
            if (entry.isSymbolicLink() || (await lstat(path.join(directory.absolutePath, entry.name))).isSymbolicLink()) {
              omissions.symlinks += 1; continue;
            }
            const target = await resolveExistingFileToolTarget(this.workspace, context, filename, { allowFinalSymlink: false });
            if (entry.isDirectory()) {
              const relative = path.relative(root.absolutePath, target.absolutePath).split(path.sep).join("/");
              if (mode === "list" && (!matchers || matchers.some((matcher) => matcher.test(request.glob!.includes("/") ? relative : entry.name)))) {
                push({ path: target.displayPath, kind: "directory", ...(excluded ? { excludedFromSearch: true } : {}) });
              }
              if (!excluded && depth < maxDepth) queue.push({ target, depth: depth + 1 });
              else if (mode === "search") omissions.depthLimited += 1;
            }
            else if (entry.isFile()) await scan(target);
          } catch (error) {
            check();
            omissions.unreadable += 1;
          }
        }
      };
      check();
      if ((await stat(root.absolutePath)).isDirectory()) {
        queue.push({ target: root, depth: 1 });
        // Breadth first: inspect root files before dependency trees consume the budget.
        for (let index = 0; index < queue.length && !stopped; index += 1) {
          const directory = queue[index]!;
          await walk(directory.target, directory.depth);
        }
      }
      else await scan(root);
      const truncated = Boolean(stopped) || omissions.oversized > 0 || omissions.unreadable > 0 || omissions.depthLimited > 0;
      const searchIdentity = sha256(JSON.stringify({ path: root.displayPath, glob: request.glob ?? null,
        query: request.query ?? null, caseSensitive: request.caseSensitive ?? false, mode, maxDepth }));
      const outcomeIdentity = sha256(JSON.stringify({ matches, omissions, truncated, stopReason: stopped ?? null }));
      const guidance = truncated
        ? "Partial results: narrow path or use mode=list to inspect one directory; do not repeat the same broad search or infer absence."
        : matches.length === 0 ? "No matches in the searched scope; check the path/pattern or use mode=list before broadening." : "Read relevant files to answer; search results do not authorize edits.";
      return toolSuccess(`${mode === "list" ? "Listed" : "Found"} ${matches.length} entries; scanned ${entries} entries${truncated ? `; partial (${stopped ?? "omissions"})` : ""}. ${guidance}`, {
        matches, scannedFiles: files, scannedEntries: entries, scannedBytes: bytes, omissions,
        truncated, stopReason: stopped ?? null, mode, maxDepth, searchIdentity, outcomeIdentity,
        repeatWarningCount: limits.searchRepeatWarningCount,
      });
    } catch (error) { return toolFailure(error, "Unable to search files"); }
  }
}
