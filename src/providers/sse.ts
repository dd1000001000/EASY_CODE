import { TextDecoder } from "node:util";

export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
}

export class SseDecodingError extends Error {}

/** Incremental UTF-8/SSE decoder. Network chunks may split code points or lines. */
export class ServerSentEventDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private eventName: string | undefined;
  private dataLines: string[] = [];

  push(chunk: Buffer | string): ServerSentEvent[] {
    this.buffer += typeof chunk === "string"
      ? chunk
      : this.decode(chunk, false);
    return this.drain(false);
  }

  finish(): ServerSentEvent[] {
    this.buffer += this.decode(undefined, true);
    return this.drain(true);
  }

  private decode(chunk: Buffer | undefined, final: boolean): string {
    try { return this.decoder.decode(chunk, { stream: !final }); }
    catch { throw new SseDecodingError("Provider returned invalid UTF-8 in an SSE response"); }
  }

  private drain(final: boolean): ServerSentEvent[] {
    const output: ServerSentEvent[] = [];
    let newline = this.buffer.search(/[\r\n]/u);
    while (newline >= 0) {
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (!final && newline === this.buffer.length - 1 && this.buffer[newline] === "\r") break;
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.slice(newline, newline + 2) === "\r\n" ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      this.consumeLine(line, output);
      newline = this.buffer.search(/[\r\n]/u);
    }
    if (final && this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r")
        ? this.buffer.slice(0, -1)
        : this.buffer;
      this.buffer = "";
      this.consumeLine(line, output);
    }
    // EOF does not dispatch an unterminated SSE event. The protocol owner must
    // reject a response which never supplied its terminal event.
    if (final) { this.dataLines = []; this.eventName = undefined; }
    return output;
  }

  private consumeLine(line: string, output: ServerSentEvent[]): void {
    if (line === "") {
      this.dispatch(output);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
  }

  private dispatch(output: ServerSentEvent[]): void {
    if (this.dataLines.length > 0) {
      output.push({
        ...(this.eventName ? { event: this.eventName } : {}),
        data: this.dataLines.join("\n"),
      });
    }
    this.eventName = undefined;
    this.dataLines = [];
  }
}

export function isEventStreamContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value.join(";") : value ?? "";
  return /(?:^|;)\s*text\/event-stream(?:\s*;|$)/iu.test(contentType);
}
