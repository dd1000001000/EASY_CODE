import { StringDecoder } from "node:string_decoder";
import type { OutputDigest } from "./types.js";

const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const UNSAFE_TERMINAL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu;

const SECRET_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:qwen|deepseek|glm|zai|zhipuai|openai|anthropic)[-_]?(?:api[-_]?)?key\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]"],
  [/\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|authorization|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]"],
  [/(\B--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|authorization|password|passwd|secret)\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/giu, "$1[REDACTED]"],
  [/:\/\/([^\s/:@]+):([^\s/@]+)@/gu, "://$1:[REDACTED]@"],
];

export function sanitizeCommandOutput(value: string): string {
  let sanitized = value.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.replace(UNSAFE_TERMINAL_CHARACTERS, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
  });
}

/** Bounded, streaming output retention with head/tail diagnostics. */
export class OutputCollector {
  private readonly decoder = new StringDecoder("utf8");
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail = "";
  private pending = "";
  private retainedChars = 0;
  private finished = false;
  private _totalBytes = 0;

  constructor(private readonly maxChars: number) {
    const bounded = Math.max(256, maxChars);
    this.headLimit = Math.ceil(bounded / 2);
    this.tailLimit = Math.floor(bounded / 2);
  }

  push(chunk: Buffer | string): void {
    if (this.finished) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this._totalBytes += buffer.length;
    this.pending += this.decoder.write(buffer);

    // Keep overlap so a secret/control sequence split across adjacent chunks is
    // still sanitized before it reaches retained output.
    if (this.pending.length > 512) {
      const safePrefixLength = this.pending.length - 256;
      this.retain(sanitizeCommandOutput(this.pending.slice(0, safePrefixLength)));
      this.pending = this.pending.slice(safePrefixLength);
    }
  }

  finish(): OutputDigest {
    if (!this.finished) {
      this.pending += this.decoder.end();
      this.retain(sanitizeCommandOutput(this.pending));
      this.pending = "";
      this.finished = true;
    }

    const truncated = this.retainedChars > this.maxChars;
    const text = truncated
      ? `${this.head}\n... [output truncated] ...\n${this.tail}`
      : this.head + this.tail;
    return {
      head: this.head,
      tail: this.tail,
      text,
      totalBytes: this._totalBytes,
      truncated,
    };
  }

  private retain(value: string): void {
    if (!value) return;
    this.retainedChars += value.length;

    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      this.head += value.slice(0, needed);
      value = value.slice(needed);
    }
    if (!value) return;

    this.tail = (this.tail + value).slice(-this.tailLimit);
  }
}
