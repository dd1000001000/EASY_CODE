import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { DocumentConverter } from "./document-converter.js";
import { ThreadResourceStore } from "./thread-resource-store.js";
import type { ThreadResourceAttachment } from "./types.js";

const MEDIA_TYPES = new Map<string, string>([
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".pdf", "application/pdf"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export function documentMediaType(filename: string, supplied?: string): string {
  const normalized = supplied?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized.slice(0, 160);
  return MEDIA_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream";
}

export function isSupportedDocument(filename: string): boolean {
  return MEDIA_TYPES.has(path.extname(filename).toLowerCase());
}

/** One conversion/storage path shared by hosted uploads and workspace tools. */
export class ThreadDocumentService {
  constructor(
    private readonly converter: DocumentConverter,
    private readonly resources: ThreadResourceStore,
  ) {}

  get maxBytes(): number { return this.resources.maxBytes; }

  async import(input: {
    threadId: string;
    data: Buffer;
    filename: string;
    mediaType?: string;
    signal?: AbortSignal;
  }): Promise<ThreadResourceAttachment> {
    if (!isSupportedDocument(input.filename)) {
      throw new Error(`Unsupported document type: ${path.extname(input.filename) || "no extension"}.`);
    }
    if (input.data.byteLength > this.maxBytes) {
      throw new Error(`Document exceeds the configured ${this.maxBytes}-byte limit.`);
    }
    input.signal?.throwIfAborted();
    const sourceSha256 = sha256(input.data);
    const existing = await this.resources.findDocumentBySourceHash(input.threadId, sourceSha256);
    if (existing) return existing;
    const mediaType = documentMediaType(input.filename, input.mediaType);
    const markdown = await this.converter.convert(
      input.data,
      input.filename,
      mediaType,
      input.signal,
    );
    input.signal?.throwIfAborted();
    return this.resources.create({
      threadId: input.threadId,
      filename: input.filename,
      kind: "document",
      mediaType,
      markdown,
      byteSize: input.data.byteLength,
      sourceSha256,
      original: input.data,
    });
  }
}
