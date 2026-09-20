export interface ClipboardExecutionContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Shared security boundary for the three clipboard implementations. */
export interface ClipboardPlatformHost {
  readonly sourceEnv: NodeJS.ProcessEnv;
  run(program: string, args: readonly string[], maxOutputBytes: number, execution: ClipboardExecutionContext): Promise<Buffer>;
  resolveFixedProgram(program: string, platform: "win32" | "darwin" | "linux"): Promise<string>;
  resolveUnixHelper(name: "wl-paste" | "xclip"): Promise<string>;
  windowsRoot(): string;
  readTemporaryFile(file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

export interface ClipboardPlatformReader {
  readImage(execution: ClipboardExecutionContext): Promise<Buffer>;
  readText(execution: ClipboardExecutionContext): Promise<Buffer>;
}

export function clipboardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isClipboardAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
