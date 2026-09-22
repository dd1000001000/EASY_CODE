import { z } from "zod";

import { MAX_MEMORY_MUTATIONS_PER_TURN, type ModelProvider, type MemoryMutationRequest, type SessionState } from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { redactSensitiveInformation } from "./sensitive.js";
import {
  GLOBAL_MEMORY_WORKSPACE_ID,
  type MemoryManager,
  projectMemoryIdFromRoot,
} from "./memory-manager.js";

const MAX_CANDIDATES = 6;
const IDLE_DELAY_MS = 2 * 60 * 1000;

const consolidationSchema = z.object({
  decisions: z.array(z.object({
    index: z.number().int().min(0).max(MAX_CANDIDATES - 1),
    action: z.enum(["merge", "skip"]),
    memoryId: z.string().optional(),
    content: z.string().min(8).max(16_000).optional(),
  }).strict()).max(MAX_CANDIDATES),
}).strict();

interface JobRow {
  turn_id: string;
  thread_id: string;
  result_reason: "success" | "planned";
}

interface CandidateMemory {
  id: string;
  scope: "project" | "global";
  category: "preference" | "convention" | "architecture" | "decision" | "environment";
  content: string;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  return JSON.parse(trimmed);
}

/** Persistent, best-effort consolidation of memories already written by the main agent. */
export class MemoryMaintenance {
  private readonly projectId: string;

  constructor(
    private readonly storage: EasyCodeStorage,
    private readonly manager: MemoryManager,
    workspaceRoot: string,
    projectId?: string,
  ) {
    this.projectId = projectId ?? projectMemoryIdFromRoot(workspaceRoot);
  }

  recover(threadId: string): void {
    this.storage.db.prepare(
      "UPDATE memory_maintenance_jobs SET status = 'queued', updated_at = ? WHERE thread_id = ? AND status = 'running'",
    ).run(new Date().toISOString(), threadId);
  }

  enqueueCompleted(threadId: string, now = new Date()): number {
    const before = new Date(now.getTime() - IDLE_DELAY_MS).toISOString();
    return this.storage.db.prepare(
      `INSERT OR IGNORE INTO memory_maintenance_jobs(turn_id, thread_id, status, updated_at)
       SELECT id, thread_id, 'queued', ? FROM turns
       WHERE thread_id = ? AND status = 'completed' AND result_reason IN ('success', 'planned')
         AND completed_at <= ?
         AND EXISTS (SELECT 1 FROM memories m WHERE m.source_turn_id = turns.id
           AND m.source_thread_id = turns.thread_id AND m.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM memory_maintenance_jobs j WHERE j.turn_id = turns.id)
       ORDER BY completed_at DESC LIMIT 24`,
    ).run(now.toISOString(), threadId, before).changes;
  }

  private next(threadId: string): JobRow | undefined {
    return this.storage.db.prepare<[string], JobRow>(
      `SELECT j.turn_id, j.thread_id, t.result_reason
       FROM memory_maintenance_jobs j JOIN turns t ON t.id = j.turn_id
       WHERE j.thread_id = ? AND j.status = 'queued' ORDER BY t.completed_at LIMIT 1`,
    ).get(threadId);
  }

  hasPending(threadId: string): boolean {
    return this.next(threadId) !== undefined;
  }

  private candidates(threadId: string, turnId: string): CandidateMemory[] {
    return this.storage.db.prepare<[string, string, string, string, number], CandidateMemory>(
      `SELECT id, scope, category, content FROM memories
       WHERE source_thread_id = ? AND source_turn_id = ? AND status = 'active'
         AND workspace_id IN (?, ?)
       ORDER BY id LIMIT ?`,
    ).all(threadId, turnId, this.projectId, GLOBAL_MEMORY_WORKSPACE_ID, MAX_CANDIDATES);
  }

  private async modelJson(jobId: string, provider: ModelProvider, instruction: string, input: object,
    signal?: AbortSignal): Promise<unknown> {
    this.storage.db.prepare(
      "UPDATE memory_maintenance_jobs SET model_requests = model_requests + 1 WHERE turn_id = ?",
    ).run(jobId);
    const response = await provider.complete({
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: JSON.stringify(input) },
      ],
      tools: [], responseMode: "buffered", maxRetries: 0, thinkingEffort: "low", signal,
    });
    this.storage.db.prepare(
      `UPDATE memory_maintenance_jobs
          SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?
        WHERE turn_id = ?`,
    ).run(response.usage?.promptTokens ?? 0, response.usage?.completionTokens ?? 0, jobId);
    return parseJsonResponse(response.message.content ?? "");
  }

  async processNext(threadId: string, state: Readonly<SessionState>, provider: ModelProvider,
    signal?: AbortSignal): Promise<boolean> {
    if (state.threadId !== threadId || state.activeTurnId || signal?.aborted) return false;
    const job = this.next(threadId);
    if (!job) return false;
    const now = new Date().toISOString();
    this.storage.db.prepare(
      "UPDATE memory_maintenance_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE turn_id = ? AND status = 'queued'",
    ).run(now, job.turn_id);
    try {
      const candidates = this.candidates(threadId, job.turn_id);
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");
      if (!candidates.length) {
        this.complete(job.turn_id);
        return true;
      }
      const matches = await Promise.all(candidates.map(async (candidate) => {
        const owner = candidate.scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : this.projectId;
        const found = await this.manager.searchHybrid(owner, candidate.content,
          {
            limit: this.manager.limits.memoryConsolidationMatchLimit,
            ranking: "consolidation",
            filter: {
              scope: candidate.scope,
              category: candidate.category,
              status: "active",
              excludeMemoryId: candidate.id,
            },
          });
        return found.map((item) => ({ id: item.id, category: item.category, content: item.content }));
      }));
      if (matches.every((items) => items.length === 0)) {
        this.complete(job.turn_id);
        return true;
      }
      const consolidated = consolidationSchema.parse(await this.modelJson(job.turn_id, provider,
        "Consolidate only memories already created by the agent's write_memory tool. Never create a new memory or change its scope. " +
        "Return only JSON {\"decisions\":[{\"index\":0,\"action\":\"merge|skip\",\"memoryId\":\"matching existing ID\",\"content\":\"concise merged statement\"}]}. " +
        "Merge only equivalent or compatible statements and preserve both qualifications; skip conflicts. " +
        "Identify the older matching record to revise and the new candidate to expire. Each index appears at most once.",
        { candidates: candidates.map((candidate, index) => ({ index, ...candidate, matches: matches[index] })) }, signal));
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");

      const seen = new Set<number>();
      const mutations: MemoryMutationRequest[] = [];
      for (const decision of consolidated.decisions) {
        if (seen.has(decision.index)) continue;
        seen.add(decision.index);
        const candidate = candidates[decision.index];
        if (!candidate || decision.action !== "merge" || !decision.memoryId || !decision.content ||
            !matches[decision.index]?.some((item) => item.id === decision.memoryId) ||
            decision.content.length > this.manager.limits.memoryContentMaxChars) continue;
        if (mutations.length + 2 > MAX_MEMORY_MUTATIONS_PER_TURN) break;
        mutations.push({ action: "revise", memoryId: decision.memoryId, scope: candidate.scope,
          category: candidate.category, content: decision.content, reason: "Background consolidation of existing memory" });
        mutations.push({ action: "forget", memoryId: candidate.id, scope: candidate.scope,
          reason: "Merged into an existing compatible memory" });
      }
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");
      this.manager.applyModelMutations({ workspaceId: this.projectId, workspaceRoot: state.workspaceRoot,
        threadId, turnId: job.turn_id, outcome: job.result_reason,
        mutations }, () => this.complete(job.turn_id));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        this.storage.db.prepare(
          "UPDATE memory_maintenance_jobs SET status = 'queued', attempts = MAX(0, attempts - 1), updated_at = ? WHERE turn_id = ?",
        ).run(new Date().toISOString(), job.turn_id);
        return true;
      }
      this.storage.db.prepare(
        "UPDATE memory_maintenance_jobs SET status = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END, error = ?, updated_at = ? WHERE turn_id = ?",
      ).run(redactSensitiveInformation(message).slice(0, 500), new Date().toISOString(), job.turn_id);
      return true;
    }
  }

  private complete(turnId: string): void {
    this.storage.db.prepare(
      "UPDATE memory_maintenance_jobs SET status = 'done', error = NULL, updated_at = ? WHERE turn_id = ?",
    ).run(new Date().toISOString(), turnId);
  }
}
