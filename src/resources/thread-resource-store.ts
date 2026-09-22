import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { sha256 } from "../utils/hash.js";
import type { ThreadResourceAttachment, ThreadResourceKind, ThreadResourceRecord } from "./types.js";

export const THREAD_RESOURCE_SCHEME = "thread-resource://";
export const MAX_THREAD_RESOURCE_UPLOAD_BYTES = 50 * 1024 * 1024;
const THREAD_ID = /^[A-Za-z0-9._-]+$/u;
const RESOURCE_ID = /^resource_[0-9a-f-]{36}$/u;
const METADATA = "resource.json";
const CONTENT = "content.md";

function assertThreadId(value: string): void {
  if (!THREAD_ID.test(value)) throw new Error("Invalid conversation ID.");
}

function assertResourceId(value: string): void {
  if (!RESOURCE_ID.test(value)) throw new Error("Invalid Thread resource ID.");
}

function safeFilename(value: string): string {
  const normalized = path.basename(value.trim()).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!normalized || normalized === "." || normalized === "..") return "document";
  return normalized.slice(0, 240);
}

function resourceUri(id: string): string { return `${THREAD_RESOURCE_SCHEME}${id}/${CONTENT}`; }

export function parseThreadResourceUri(value: string): { id: string } | undefined {
  if (!value.startsWith(THREAD_RESOURCE_SCHEME)) return undefined;
  const match = /^thread-resource:\/\/(resource_[0-9a-f-]{36})\/content\.md$/u.exec(value);
  if (!match) throw new Error("Thread resource paths must use thread-resource://<resource-id>/content.md.");
  return { id: match[1]! };
}

export class ThreadResourceStore {
  private readonly threadsRoot: string;

  constructor(dataDir: string) { this.threadsRoot = path.resolve(dataDir, "threads"); }

  private resourcesRoot(threadId: string): string {
    assertThreadId(threadId);
    return path.join(this.threadsRoot, threadId, "resources");
  }

  private resourceRoot(threadId: string, id: string): string {
    assertResourceId(id);
    return path.join(this.resourcesRoot(threadId), id);
  }

  private async ensureResourcesRoot(threadId: string): Promise<string> {
    const threadRoot = path.join(this.threadsRoot, threadId);
    const resourcesRoot = this.resourcesRoot(threadId);
    for (const directory of [this.threadsRoot, threadRoot, resourcesRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing to use a linked Thread resource directory.");
    }
    return realpath(resourcesRoot);
  }

  private async existingResourcesRoot(threadId: string): Promise<string> {
    const threadRoot = path.join(this.threadsRoot, threadId);
    const resourcesRoot = this.resourcesRoot(threadId);
    try {
      for (const directory of [this.threadsRoot, threadRoot, resourcesRoot]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing to use a linked Thread resource directory.");
      }
      return await realpath(resourcesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Thread resource is unavailable.");
      throw error;
    }
  }

  private async readRecord(threadId: string, id: string): Promise<ThreadResourceRecord> {
    const root = this.resourceRoot(threadId, id);
    const canonicalResources = await this.existingResourcesRoot(threadId);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Thread resource is unavailable.");
    const canonicalRoot = await realpath(root);
    if (!canonicalRoot.startsWith(canonicalResources + path.sep)) throw new Error("Thread resource escaped its private directory.");
    const raw = JSON.parse(await readFile(path.join(root, METADATA), "utf8")) as Partial<ThreadResourceRecord>;
    if (raw.version !== 1 || raw.threadId !== threadId || raw.id !== id || raw.uri !== resourceUri(id) ||
        typeof raw.filename !== "string" || (raw.kind !== "document" && raw.kind !== "webpage") ||
        typeof raw.mediaType !== "string" || typeof raw.byteSize !== "number" ||
        typeof raw.contentSha256 !== "string" || typeof raw.totalLines !== "number" ||
        typeof raw.createdAt !== "string") throw new Error("Thread resource metadata is invalid.");
    return raw as ThreadResourceRecord;
  }

  async create(input: {
    threadId: string;
    filename: string;
    kind: ThreadResourceKind;
    mediaType: string;
    markdown: string;
    byteSize: number;
    sourceUrl?: string;
    original?: Buffer;
  }): Promise<ThreadResourceAttachment> {
    assertThreadId(input.threadId);
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > MAX_THREAD_RESOURCE_UPLOAD_BYTES) {
      throw new Error(`Resource exceeds the ${MAX_THREAD_RESOURCE_UPLOAD_BYTES}-byte limit.`);
    }
    const id = `resource_${randomUUID()}`;
    const finalRoot = this.resourceRoot(input.threadId, id);
    const resourcesRoot = this.resourcesRoot(input.threadId);
    const temporary = path.join(resourcesRoot, `.pending-${id}`);
    await this.ensureResourcesRoot(input.threadId);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const normalized = input.markdown.replace(/\r\n|\r/gu, "\n");
      const totalLines = normalized.split("\n").length;
      const record: ThreadResourceRecord = {
        version: 1,
        threadId: input.threadId,
        id,
        filename: safeFilename(input.filename),
        kind: input.kind,
        mediaType: input.mediaType.slice(0, 160),
        uri: resourceUri(id),
        byteSize: input.byteSize,
        createdAt: new Date().toISOString(),
        contentSha256: sha256(normalized),
        totalLines,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      };
      await writeFile(path.join(temporary, CONTENT), normalized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (input.original) await writeFile(path.join(temporary, "original.bin"), input.original, { mode: 0o600, flag: "wx" });
      await writeFile(path.join(temporary, METADATA), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, finalRoot);
      return this.toAttachment(record);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async remove(threadId: string, id: string): Promise<void> {
    const root = this.resourceRoot(threadId, id);
    await this.readRecord(threadId, id);
    await rm(root, { recursive: true, force: true });
  }

  async get(threadId: string, uriOrId: string): Promise<ThreadResourceRecord> {
    const parsed = parseThreadResourceUri(uriOrId);
    return this.readRecord(threadId, parsed?.id ?? uriOrId);
  }

  async list(threadId: string): Promise<readonly ThreadResourceRecord[]> {
    const root = this.resourcesRoot(threadId);
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: ThreadResourceRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RESOURCE_ID.test(entry.name)) continue;
      try { records.push(await this.readRecord(threadId, entry.name)); } catch { /* Ignore incomplete private entries. */ }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async contentPath(threadId: string, uri: string): Promise<{ record: ThreadResourceRecord; path: string }> {
    const parsed = parseThreadResourceUri(uri);
    if (!parsed) throw new Error("Not a Thread resource path.");
    const record = await this.readRecord(threadId, parsed.id);
    const root = this.resourceRoot(threadId, parsed.id);
    const filename = path.join(root, CONTENT);
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(filename);
    if (path.dirname(canonicalFile) !== canonicalRoot || (await lstat(canonicalFile)).isSymbolicLink() || !(await stat(canonicalFile)).isFile()) {
      throw new Error("Thread resource content escaped its private directory.");
    }
    return { record, path: canonicalFile };
  }

  async readLines(threadId: string, uri: string, startLine: number, endLine: number): Promise<{ record: ThreadResourceRecord; lines: string[] }> {
    const target = await this.contentPath(threadId, uri);
    const lines: string[] = [];
    let line = 0;
    const stream = createReadStream(target.path, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const value of reader) {
        line += 1;
        if (line >= startLine && line <= endLine) lines.push(value);
        if (line >= endLine) break;
      }
    } finally { reader.close(); stream.destroy(); }
    // An empty Markdown resource still has one logical (empty) line because
    // totalLines is derived from splitting the normalized content on "\n".
    if (line === 0 && target.record.totalLines === 1 && startLine === 1) lines.push("");
    return { record: target.record, lines };
  }

  private toAttachment(record: ThreadResourceRecord): ThreadResourceAttachment {
    return {
      id: record.id, filename: record.filename, kind: record.kind, mediaType: record.mediaType,
      uri: record.uri, byteSize: record.byteSize, createdAt: record.createdAt,
      ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    };
  }
}
