import { NativeAppServerRequestError } from "./app-server-client.js";
import type { SandboxWorkerControl } from "./types.js";

export interface NativeSandboxBoundaryResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  event: Extract<SandboxWorkerControl, { type: "sandbox_boundary_violation" }>;
}

function errorText(error: NativeAppServerRequestError): string {
  let data = "";
  try { data = JSON.stringify(error.data); } catch { /* The message remains usable if third-party data is malformed. */ }
  return `${error.message}\n${data}`.slice(0, 16_384);
}

function findField(value: unknown, names: readonly string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) if (record[name] !== undefined) return record[name];
  for (const nested of Object.values(record)) {
    const found = findField(nested, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Convert only an explicit app-server sandbox denial. Generic permission
 * errors and transport failures remain unclassified and therefore fail closed. */
export function sandboxBoundaryResultFromError(error: unknown): NativeSandboxBoundaryResult | undefined {
  if (!(error instanceof NativeAppServerRequestError)) return undefined;
  const text = errorText(error);
  if (!/(?:sandbox.{0,80}(?:denied|violation|not permitted)|(?:denied|violation).{0,80}sandbox)/isu.test(text)) return undefined;
  const structuredExit = findField(error.data, ["exitCode", "exit_code", "code"]);
  const parsedExit = Number.isSafeInteger(structuredExit) ? Number(structuredExit) : Number(/exit code\s*[:=]?\s*(\d+)/iu.exec(text)?.[1] ?? 1);
  const stdout = findField(error.data, ["stdout", "standardOutput"]);
  const stderr = findField(error.data, ["stderr", "standardError"]);
  const destination = findField(error.data, ["path", "destination", "targetPath"]);
  const access = /(?:delete|remove|unlink|rmdir)/iu.test(text) ? "delete" as const
    : /(?:write|create|mkdir|rename|modify)/iu.test(text) ? "write" as const
      : /(?:execute|exec|spawn)/iu.test(text) ? "execute" as const
        : /(?:read|open|stat)/iu.test(text) ? "read" as const : "unknown" as const;
  return {
    exitCode: Number.isSafeInteger(parsedExit) && parsedExit > 0 ? parsedExit : 1,
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" && stderr.length ? stderr : error.message,
    event: { type: "sandbox_boundary_violation", access,
      ...(typeof destination === "string" ? { destination: destination.slice(0, 4096) } : {}),
      destinationCategory: "unknown", message: error.message.slice(0, 1200) },
  };
}
