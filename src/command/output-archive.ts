import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../utils/hash.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";

type Stream = "stdout" | "stderr";
export interface OutputArchiveReference {
  evidenceId: string; capturedChars: number; observedChars: number;
  sourceTruncated: boolean; complete: boolean; unavailable: boolean;
}
const scopeDirectory = (root: string, workspace: string, thread: string) =>
  path.join(root, sha256(workspace), sha256(thread));

/** Receives SANITIZED text before in-memory head/tail retention. A finite disk
 * quota is independent of model context; missing suffixes are always explicit.
 * UTF-16LE gives bounded random access with character offsets, no 32 MiB reread. */
export class CommandOutputArchive {
  private readonly directory: string;
  private readonly streams: Record<Stream, OutputArchiveReference>;
  private bytes = 0;
  private closed = false;
  constructor(root: string, workspace: string, thread: string, commandId: string, private readonly limits: Readonly<RuntimeLimits>) {
    this.directory = scopeDirectory(root, workspace, thread);
    const create = (stream: Stream): OutputArchiveReference => ({
      evidenceId: `command_output_${sha256(JSON.stringify([workspace, thread, commandId, stream]))}`,
      capturedChars: 0, observedChars: 0, sourceTruncated: false, complete: false, unavailable: false,
    });
    this.streams = { stdout: create("stdout"), stderr: create("stderr") };
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      for (const value of Object.values(this.streams)) writeFileSync(this.filename(value.evidenceId), "", { flag: "wx", mode: 0o600 });
    } catch { for (const value of Object.values(this.streams)) value.unavailable = true; }
  }
  private filename(id: string) { return path.join(this.directory, `${id}.log`); }
  push(stream: Stream, text: string): void {
    if (this.closed || !text) return;
    const value = this.streams[stream];
    value.observedChars += text.length;
    if (value.unavailable || value.sourceTruncated) { value.sourceTruncated = true; return; }
    try {
      const used = readdirSync(this.directory).filter(name => /^command_output_[a-f0-9]{64}\.log$/u.test(name))
        .reduce((sum, name) => sum + statSync(path.join(this.directory, name)).size, 0);
      const room = Math.max(0, Math.min(this.limits.commandArchiveMaxBytes - this.bytes, this.limits.commandThreadArchiveMaxBytes - used));
      let prefix = text.slice(0, Math.floor(room / 2));
      if (prefix.length < text.length && /[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
      if (prefix) appendFileSync(this.filename(value.evidenceId), prefix, { encoding: "utf16le" });
      this.bytes += prefix.length * 2; value.capturedChars += prefix.length;
      value.sourceTruncated = prefix.length !== text.length;
    } catch { value.unavailable = true; value.sourceTruncated = true; }
  }
  reference(stream: Stream): OutputArchiveReference { return { ...this.streams[stream] }; }
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const value of Object.values(this.streams)) {
      value.complete = !value.unavailable && !value.sourceTruncated;
      try { writeFileSync(this.filename(value.evidenceId) + ".json", JSON.stringify(value), { mode: 0o600 }); }
      catch { value.complete = false; value.unavailable = true; }
    }
  }
  static read(root: string, workspace: string, thread: string, id: string, offset: number, limit: number): object {
    if (!/^command_output_[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid command output reference");
    const filename = path.join(scopeDirectory(root, workspace, thread), `${id}.log`);
    const captured = Math.floor(statSync(filename).size / 2);
    if (offset > captured) throw new Error("Command output offset exceeds captured text");
    let metadata: Partial<OutputArchiveReference> = {};
    if (existsSync(filename + ".json")) metadata = JSON.parse(readFileSync(filename + ".json", "utf8"));
    const buffer = Buffer.alloc(Math.min(limit, captured - offset) * 2);
    const fd = openSync(filename, "r");
    let read = 0;
    try { read = readSync(fd, buffer, 0, buffer.length, offset * 2); } finally { closeSync(fd); }
    let content = buffer.subarray(0, read).toString("utf16le");
    if (/^[\uDC00-\uDFFF]/u.test(content)) throw new Error("Evidence offset splits a Unicode character; use the previous character offset");
    if (offset + content.length < captured && /[\uD800-\uDBFF]$/u.test(content)) {
      if (content.length === 1) throw new Error("Evidence page must fit one complete Unicode character");
      content = content.slice(0, -1);
    }
    return { evidenceId: id, tool: "command_output", content, offset,
      nextOffset: offset + content.length < captured ? offset + content.length : null,
      capturedChars: captured, observedChars: metadata.observedChars, complete: metadata.complete === true,
      sourceTruncated: metadata.complete !== true, historical: true,
      missingRange: metadata.sourceTruncated ? { start: captured, end: metadata.observedChars } : undefined,
      warning: "Captured command text is historical output, not proof about the current checkout." };
  }
}
