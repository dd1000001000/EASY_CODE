import { commandVerificationKind, VERIFICATION_KINDS, type RunCommandInput, type VerificationKind } from "./types.js";

export interface CommandRequestMetadata {
  experimentIncidentId?: string;
  intent: RunCommandInput["intent"];
  verificationKind?: VerificationKind;
  warnings: string[];
}

/** Metadata cannot grant permissions or prevent an otherwise executable request. */
export function normalizeCommandRequest(
  request: Omit<RunCommandInput, "verificationKind"> & { verificationKind?: unknown },
): RunCommandInput {
  const warnings = [...(request.normalizationWarnings ?? [])].slice(0, 4);
  const supplied = request.verificationKind;
  const recognized = typeof supplied === "string" && VERIFICATION_KINDS.includes(supplied as VerificationKind)
    ? supplied as VerificationKind : undefined;
  const verification = ["verify", "test", "build"].includes(request.intent);
  if (supplied !== undefined && (!recognized || !verification)) {
    warnings.push("Invalid or inapplicable verificationKind ignored; command execution is unchanged.");
  }
  if (request.intent === "verify" && !recognized) {
    warnings.push("verificationKind defaulted to custom.");
  }
  const { verificationKind: _supplied, normalizationWarnings: _warnings, ...execution } = request;
  const kind = commandVerificationKind({ intent: request.intent, ...(recognized ? { verificationKind: recognized } : {}) });
  return {
    ...execution,
    ...(kind ? { verificationKind: kind } : {}),
    ...(warnings.length ? { normalizationWarnings: [...new Set(warnings)].slice(0, 4) } : {}),
  };
}

export function commandRequestMetadata(input: RunCommandInput): CommandRequestMetadata {
  return { intent: input.intent, ...(input.verificationKind ? { verificationKind: input.verificationKind } : {}),
    warnings: input.normalizationWarnings ?? [] };
}
