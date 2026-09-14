import type { PromptBundleBinding, SessionState } from "../core/types.js";

export interface CurrentSessionBindings {
  readonly promptBundle: PromptBundleBinding;
  readonly modelRegistryHash: string;
}

function promptBundleMatches(
  stored: PromptBundleBinding | undefined,
  current: PromptBundleBinding,
): boolean {
  if (!stored) return false;
  return stored.formatVersion === current.formatVersion &&
    stored.bundleVersion === current.bundleVersion &&
    stored.bundleHash === current.bundleHash &&
    stored.manifestHash === current.manifestHash &&
    stored.toolCatalogHash === current.toolCatalogHash;
}

/**
 * Reject a task before Resume changes leases, workspaces or Runtime state.
 * This boundary deliberately validates rather than migrates development data.
 */
export function assertCurrentSessionBindings(
  state: Readonly<SessionState>,
  current: Readonly<CurrentSessionBindings>,
): void {
  if (!state.promptBundle) {
    throw new Error(`Thread ${state.threadId} has no current Prompt Bundle binding.`);
  }
  if (!promptBundleMatches(state.promptBundle, current.promptBundle)) {
    throw new Error(
      `Thread ${state.threadId} is bound to a different Prompt Bundle. ` +
      "Restore the matching installation or create a new task.",
    );
  }
  if (!state.modelRegistryHash) {
    throw new Error(`Thread ${state.threadId} has no current model-registry binding.`);
  }
  if (state.modelRegistryHash !== current.modelRegistryHash) {
    throw new Error(
      `Thread ${state.threadId} is bound to a different ~/.easy_code/models.toml. ` +
      "Restore that registry or start a new thread; endpoints and wire protocols are never changed silently on Resume.",
    );
  }
}
