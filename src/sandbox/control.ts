import type { OutputDigest } from "../command/types.js";
import type { SandboxWorkerControl } from "./types.js";

const CONTROL_PREFIX = "[[EASY_CODE_SANDBOX:";
const CONTROL_PATTERN = /\[\[EASY_CODE_SANDBOX:([^:\]]+):([A-Za-z0-9_-]+)\]\]\r?\n?/gu;

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
    if (["execution_request_sent", "target_started", "cleanup_complete", "cleanup_requested"].includes(String(type))) return value as SandboxWorkerControl;
    if (type === "execution_exited" && Number.isSafeInteger((value as { exitCode?: unknown }).exitCode) &&
        ((value as { outcome?: unknown }).outcome === undefined ||
          ["exited", "timed_out", "canceled", "output_limit", "spawn_failed", "unknown"].includes(String((value as { outcome?: unknown }).outcome)))) return value as SandboxWorkerControl;
    if (type === "cleanup_error" && typeof (value as { message?: unknown }).message === "string") return value as SandboxWorkerControl;
    if (type === "ready" && ["native","benchmark-container","host-unrestricted"].includes(String((value as {backend?:unknown}).backend))) return value as SandboxWorkerControl;
    if (type === "stage" && ["worker_started","relay_start","dispatch_start","cleanup_start"].includes(String((value as {stage?:unknown}).stage))) return value as SandboxWorkerControl;
    if (type === "sandbox_error" || type === "target_spawn_error") {
      if (typeof (value as {message?:unknown}).message === "string") return value as SandboxWorkerControl;
    }
    if (type === "sandbox_boundary_violation") {
      const candidate = value as { access?: unknown; destination?: unknown; destinationCategory?: unknown; message?: unknown };
      if (["read", "write", "delete", "execute", "unknown"].includes(String(candidate.access)) &&
          ["outside_workspace", "protected_path", "unknown"].includes(String(candidate.destinationCategory)) &&
          typeof candidate.message === "string" &&
          (candidate.destination === undefined || typeof candidate.destination === "string")) return value as SandboxWorkerControl;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Control state is bounded independently from stdout/stderr and never clipped. */
export class SandboxControlStream {
  private pending = "";
  readonly controls: SandboxWorkerControl[] = [];
  private ready = false;
  private requested = false;
  private started = false;
  private exited = false;
  private cleaned = false;
  constructor(private readonly commandId: string, private readonly observe: (event: SandboxWorkerControl) => void, private readonly strict = false) {}
  push(chunk: Buffer | string): void {
    this.pending += chunk.toString();
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end + 1);
      this.pending = this.pending.slice(end + 1);
      const { controls } = extractSandboxControls(this.commandId, { head: line, tail: "", text: line, totalBytes: Buffer.byteLength(line), truncated: false });
      if (this.strict && (line.length > 32768 || controls.length !== 1)) throw new Error("Malformed private control frame");
      for (const control of controls) {
        if (this.controls.length >= 64) throw new Error("Sandbox control event bound exceeded");
        if (this.strict) {
          if (control.type === "ready") { if(this.ready||this.cleaned)throw new Error("Invalid ready transition");this.ready=true; }
          if (control.type === "execution_request_sent") {if(!this.ready||this.requested||this.cleaned)throw new Error("Invalid request transition");this.requested=true;}
          if (control.type === "target_started") {if(!this.requested||this.started||this.cleaned)throw new Error("Invalid target-start transition");this.started=true;}
          if (control.type === "target_spawn_error") {if(!this.requested||this.started||this.exited||this.cleaned)throw new Error("Invalid target-spawn-error transition");}
          if (control.type === "execution_exited") {
            if(!this.requested||this.exited||this.cleaned)throw new Error("Invalid exit transition");
            if(control.outcome !== "spawn_failed" && control.outcome !== "unknown" && !this.started)throw new Error("Exit reported before target start");
            this.exited=true;
          }
          if (control.type === "cleanup_complete"||control.type === "cleanup_error") {if(this.cleaned)throw new Error("Duplicate cleanup transition");this.cleaned=true;}
        }
        this.controls.push(control);
        this.observe(control);
      }
    }
    if (this.pending.length > 32768) throw new Error("Invalid sandbox control frame");
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
