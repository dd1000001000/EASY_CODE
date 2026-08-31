import type { OutputDigest } from "../command/types.js";
import type { SandboxWorkerControl } from "./types.js";

const CONTROL_PREFIX = "[[EASY_CODE_SRT:";
const CONTROL_PATTERN = /\[\[EASY_CODE_SRT:([^:\]]+):([A-Za-z0-9_-]+)\]\]\r?\n?/gu;

export function encodeSandboxControl(
  commandId: string,
  control: SandboxWorkerControl,
): string {
  const payload = Buffer.from(JSON.stringify(control), "utf8").toString("base64url");
  return `${CONTROL_PREFIX}${commandId}:${payload}]]\n`;
}

function decodeControl(payload: string): SandboxWorkerControl | undefined {
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || !("type" in value)) return undefined;
    const type = (value as { type?: unknown }).type;
    if (type === "ready") return value as SandboxWorkerControl;
    if (type === "stage") return value as SandboxWorkerControl;
    if (type === "sandbox_error" || type === "target_spawn_error") {
      return value as SandboxWorkerControl;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function stripValue(
  value: string,
  commandId: string,
  controls: SandboxWorkerControl[],
): string {
  return value.replace(CONTROL_PATTERN, (match, id: string, payload: string) => {
    if (id !== commandId) return match;
    const decoded = decodeControl(payload);
    if (decoded) controls.push(decoded);
    return "";
  });
}

export function extractSandboxControls(
  commandId: string,
  digest: OutputDigest,
): { digest: OutputDigest; controls: SandboxWorkerControl[] } {
  const controls: SandboxWorkerControl[] = [];
  const text = stripValue(digest.text, commandId, controls);
  // OutputDigest.text is composed from head/tail. Strip those display fields
  // too, but collect controls only once from text so callers do not observe
  // duplicate ready/error events.
  const head = stripValue(digest.head, commandId, []);
  const tail = stripValue(digest.tail, commandId, []);
  return {
    digest: { ...digest, text, head, tail },
    controls,
  };
}
