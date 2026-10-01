import type { UIProgressItem, UITranscriptKind } from "../ui/contracts.js";

export type StableStatusKind = Extract<UITranscriptKind, "info" | "success" | "warning" | "error">;

export type StatusPresentation =
  | { readonly destination: "live"; readonly kind: UIProgressItem["kind"] }
  | { readonly destination: "stable"; readonly kind: StableStatusKind };

/**
 * Runtime status defaults to durable scrollback. Only the finite, audited set
 * of in-flight messages is allowed into the replaceable live region, so a new
 * warning cannot silently disappear merely because it arrived through
 * `onStatus`.
 */
export function classifyStatus(text: string): StatusPresentation {
  if (/^Tool:\s*\S/iu.test(text)) {
    return { destination: "live", kind: "tool" };
  }
  if (/^Step\s+\d+(?:\/\d+)?:?\s*requesting\b/iu.test(text)) {
    return { destination: "live", kind: "step" };
  }
  if (/^Auto mode is choosing how to handle this request\.\.\.$/iu.test(text)) {
    return { destination: "live", kind: "status" };
  }

  if (
    /^Model (?:response headers did not arrive|stream made no semantic progress)\b/iu.test(text) ||
    /^Server rejected context capacity\b/iu.test(text)
  ) {
    return { destination: "stable", kind: "warning" };
  }
  if (/\b(?:error|failed|failure|fatal)\b/iu.test(text)) {
    return { destination: "stable", kind: "error" };
  }
  return { destination: "stable", kind: "info" };
}
