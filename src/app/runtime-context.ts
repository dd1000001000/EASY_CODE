/** Memory, tool-evidence and thread-context dependencies shared by the main and child AgentRuntimes. */

import type { EasyCodeConfig, SessionState } from "../core/types.js";
import { ContextArtifactIndex, renderContextCheckpoint, renderRetrievedContext } from "../context/artifact-index.js";
import { MemoryManager } from "../memory/memory-manager.js";
import type { AgentRuntimeDependencies } from "../runtime/agent.js";

export interface RuntimeContextSources {
  readonly memoryManager: MemoryManager;
  readonly contextArtifactIndex: ContextArtifactIndex;
  readonly limits: EasyCodeConfig["limits"];
}

/** Where a runtime's memory and context lookups are scoped. */
export interface RuntimeContextScope {
  readonly workspaceId: string;
  readonly projectMemoryId: string;
  readonly workspaceRoot: string;
  /** Prepended to memory and history queries; a child uses its task title and description. */
  readonly queryPrefix?: string;
  /** The thread whose archive owns an evidence id. */
  readonly evidenceOwner: (state: Readonly<SessionState>, id: string) => string;
}

export function runtimeContextDependencies(
  sources: RuntimeContextSources,
  scope: RuntimeContextScope,
): Pick<
  AgentRuntimeDependencies,
  "searchMemories" | "memoryGeneration" | "captureToolEvidence" | "readToolEvidence" | "getLayeredContext"
> {
  const { memoryManager, contextArtifactIndex, limits } = sources;
  const { workspaceId, projectMemoryId } = scope;
  const scoped = (query: string): string => (scope.queryPrefix ? `${scope.queryPrefix}${query}` : query);
  return {
    searchMemories: async (query, options) =>
      memoryManager.searchScoped(projectMemoryId, scoped(query), {
        workspaceRoot: scope.workspaceRoot,
        limit: options?.limit ?? limits.memorySearchLimit,
        includeInactive: options?.includeInactive,
        scope: options?.scope,
        includeGlobalPreferences: options === undefined,
      }),
    memoryGeneration: () => memoryManager.scopeGenerationKey(projectMemoryId),
    captureToolEvidence: (state, callId, tool, result) =>
      memoryManager.evidenceStore.capture(workspaceId, state.threadId, callId, tool, result),
    readToolEvidence: (state, id, offset, limit) =>
      memoryManager.evidenceStore.read(workspaceId, scope.evidenceOwner(state, id), id, offset, limit),
    getLayeredContext: async ({ state, query, beforeMessageIndex, queries }) => {
      const checkpoint = await contextArtifactIndex.checkpoint(workspaceId, state);
      const hits = await contextArtifactIndex.search(workspaceId, state.threadId, scoped(query), {
        beforeMessageIndex,
        queries,
        limit: limits.memorySearchLimit,
      });
      return {
        workingCheckpoint: renderContextCheckpoint(checkpoint.checkpoint),
        evidence: hits,
        ...(hits.length ? { retrievedThreadEvidence: renderRetrievedContext(hits) } : {}),
      };
    },
  };
}
