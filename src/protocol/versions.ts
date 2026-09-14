/**
 * Persisted protocol versions are intentionally independent. A change in one
 * storage boundary must not force unrelated transports to pretend they changed.
 */
export const CURRENT_PROTOCOL = Object.freeze({
  journalEvent: 2,
  sessionState: 2,
  checkpointDelta: 2,
  semanticSummary: 3,
  compactionMetadata: 2,
  worktreeDescriptor: 2,
  vscodeBridge: 2,
  installationManifest: 2,
} as const);

export class UnsupportedDevelopmentStateError extends Error {
  constructor(
    readonly boundary: keyof typeof CURRENT_PROTOCOL,
    readonly received: unknown,
  ) {
    super(
      `This task was created by an unsupported EASY CODE development format ` +
      `(${boundary}=${String(received)}; current=${CURRENT_PROTOCOL[boundary]}). ` +
      "The original files were preserved. Remove the local development data or create a new task.",
    );
    this.name = "UnsupportedDevelopmentStateError";
  }
}

export function requireCurrentProtocol(
  boundary: keyof typeof CURRENT_PROTOCOL,
  received: unknown,
): void {
  if (received !== CURRENT_PROTOCOL[boundary]) {
    throw new UnsupportedDevelopmentStateError(boundary, received);
  }
}

export function isUnsupportedDevelopmentState(
  error: unknown,
): error is UnsupportedDevelopmentStateError {
  return error instanceof UnsupportedDevelopmentStateError;
}
