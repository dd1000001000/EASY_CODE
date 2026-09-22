import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { DocumentConverter } from "./document-converter.js";
import { ThreadResourceStore } from "./thread-resource-store.js";
import type { ThreadResourceAttachment } from "./types.js";

const MEDIA_TYPES = new Map<string, string>([
  [".csv", "text/csv"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".pdf", "application/pdf"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export function documentMediaType(filename: string, supplied?: string): string {
  const known = MEDIA_TYPES.get(path.extname(filename).toLowerCase());
  if (known) return known;
  const normalized = supplied?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized.slice(0, 160);
  return "application/octet-stream";
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

  async importWebpage(input: {
    threadId: string;
    data: Buffer;
    url: string;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<ThreadResourceAttachment> {
    if (input.data.byteLength > this.maxBytes) {
      throw new Error(`Web page exceeds the configured ${this.maxBytes}-byte limit.`);
    }
    if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(input.mediaType)) {
      throw new Error(`Unsupported Web content type: ${input.mediaType}.`);
    }
    const html = input.mediaType === "text/html" || input.mediaType === "application/xhtml+xml";
    const extension = html ? ".html" : input.mediaType === "text/markdown" ? ".md" : ".txt";
    const converted = await this.converter.convertWithMetadata(
      input.data, `webpage${extension}`, input.mediaType, input.signal, html ? input.url : undefined,
    );
    input.signal?.throwIfAborted();
    const title = (converted.title || new URL(input.url).hostname).replace(/\s+/gu, " ").trim();
    const filename = `${title.replace(/[\\/:*?"<>|]/gu, " ").slice(0, 120) || "webpage"}.md`;
    const markdown = `# ${title}\n\nSource: ${input.url}\n\n${converted.markdown.trim()}\n`;
    return this.resources.create({
      threadId: input.threadId, filename, kind: "webpage", mediaType: "text/markdown",
      markdown, byteSize: input.data.byteLength, sourceUrl: input.url,
    });
  }
}
