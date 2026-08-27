import { StringDecoder } from "node:string_decoder";

export interface SecretInputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): this;
}

export interface SecretOutputStream {
  write(value: string): unknown;
}

const MAX_SECRET_BYTES = 16_384;

export async function readSecretInput(
  input: SecretInputStream,
  output: SecretOutputStream,
  prompt: string,
): Promise<string> {
  if (!input.isTTY) return readPipedSecret(input);
  if (typeof input.setRawMode !== "function") {
    throw new Error(
      "Hidden terminal input is unavailable. Pipe the API key through standard input instead.",
    );
  }
  return readHiddenSecret(input, output, prompt);
}

function readPipedSecret(input: SecretInputStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let byteCount = 0;
    let settled = false;
    let ended = false;
    const decoder = new StringDecoder("utf8");
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.removeListener("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value.replace(/\r?\n$/u, ""));
    };
    const onData = (chunk: Buffer | string): void => {
      byteCount +=
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, "utf8")
          : chunk.byteLength;
      value += typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (byteCount > MAX_SECRET_BYTES) {
        finish(new Error("API key input is too long."));
      }
    };
    const onEnd = (): void => {
      ended = true;
      value += decoder.end();
      finish();
    };
    const onClose = (): void => {
      if (!ended) finish(new Error("Standard input closed before the API key was read."));
    };
    const onError = (): void => finish(new Error("Unable to read API key from standard input."));
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onClose);
    input.once("error", onError);
    input.resume();
  });
}

function readHiddenSecret(
  input: SecretInputStream,
  output: SecretOutputStream,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    let escapeSequence: "none" | "start" | "control" = "none";
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing === true;
    const decoder = new StringDecoder("utf8");
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.removeListener("error", onError);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // The terminal may have disappeared while input was active.
      }
      if (wasFlowing) input.resume();
      else input.pause();
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (escapeSequence === "start") {
          escapeSequence = character === "[" || character === "O" ? "control" : "none";
          continue;
        }
        if (escapeSequence === "control") {
          // Ignore ANSI/terminal escape sequences (for example arrow keys).
          if (character >= "@" && character <= "~") escapeSequence = "none";
          continue;
        }
        if (character === "\u001B") {
          escapeSequence = "start";
          continue;
        }
        if (character === "\u0003") {
          finish(new Error("API key input was canceled."));
          return;
        }
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          return;
        }
        if (character === "\b" || character === "\u007F") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " " && character !== "\u007F") value += character;
        if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
          finish(new Error("API key input is too long."));
          return;
        }
      }
    };
    const onEnd = (): void =>
      finish(new Error("Terminal input ended before the API key was submitted."));
    const onClose = (): void =>
      finish(new Error("Terminal input closed before the API key was submitted."));
    const onError = (): void => finish(new Error("Unable to read API key from the terminal."));

    try {
      output.write(prompt);
      input.setRawMode?.(true);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onClose);
      input.once("error", onError);
      input.resume();
    } catch {
      finish(new Error("Unable to start hidden terminal input."));
    }
  });
}
