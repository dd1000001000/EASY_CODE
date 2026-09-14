export interface RecordedCommandLifecycleEvent {
  commandId?: unknown;
  type?: unknown;
  payload?: any;
}

export interface DeterministicNotStartedEvidence {
  source: "target_spawn_error";
}

/**
 * Accept only current Runtime-owned lifecycle evidence that proves the
 * operating system rejected target creation.
 */
export function deterministicNotStartedEvidence(
  events: readonly RecordedCommandLifecycleEvent[],
): DeterministicNotStartedEvidence | undefined {
  const requestRecorded = events.some(event => event.type === "execution_request_sent");
  const structured = events.some(event => event.type === "target_spawn_error");
  const finishedAsSpawnFailure = events.some(event =>
    event.type === "finished" && event.payload?.status === "spawn_failed");
  const targetStartProof = events.some(event => event.type === "target_started") || events.some(event =>
    event.type === "execution_exited" && !["spawn_failed", "unknown"].includes(String(event.payload?.outcome ?? "exited")));
  if (!requestRecorded || !structured || !finishedAsSpawnFailure || targetStartProof) return undefined;
  return { source: "target_spawn_error" };
}
