import { z } from "zod";

import {
  MAX_MEMORY_MUTATIONS_PER_TURN,
  type ModelProvider,
  type MemoryMutationRequest,
  type SessionState,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { redactSensitiveInformation } from "./sensitive.js";
import { GLOBAL_MEMORY_WORKSPACE_ID, type MemoryManager, projectMemoryIdFromRoot } from "./memory-manager.js";

const MAX_CANDIDATES = 6;
const IDLE_DELAY_MS = 2 * 60 * 1000;
/** A job still marked running after this long belongs to a process that stopped. */
const STALE_RUNNING_MS = 15 * 60 * 1000;

const consolidationSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(MAX_CANDIDATES - 1),
            action: z.enum(["merge", "conflict", "skip"]),
            memoryId: z.string().optional(),
            content: z.string().min(8).max(16_000).optional(),
          })
          .strict(),
      )
      .max(MAX_CANDIDATES),
  })
  .strict();

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
  created_at: string;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
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

  /** Requeue jobs left running by a process that stopped; a live process claims a job just before working on it. */
  recover(now = new Date()): void {
    this.storage.db
      .prepare(
        "UPDATE memory_maintenance_jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?",
      )
      .run(now.toISOString(), new Date(now.getTime() - STALE_RUNNING_MS).toISOString());
  }

  /** Queue every finished turn that wrote memory for this project, whichever conversation it belongs to. */
  enqueueCompleted(now = new Date()): number {
    const before = new Date(now.getTime() - IDLE_DELAY_MS).toISOString();
    return this.storage.db
      .prepare(
        `INSERT OR IGNORE INTO memory_maintenance_jobs(turn_id, thread_id, status, updated_at)
       SELECT DISTINCT t.id, t.thread_id, 'queued', ? FROM memories m
         JOIN turns t ON t.id = m.source_turn_id AND t.thread_id = m.source_thread_id
       WHERE m.workspace_id IN (?, ?) AND m.status = 'active'
         AND t.status = 'completed' AND t.result_reason IN ('success', 'planned') AND t.completed_at <= ?
         AND NOT EXISTS (SELECT 1 FROM memory_maintenance_jobs j WHERE j.turn_id = t.id)
       ORDER BY t.completed_at DESC LIMIT 24`,
      )
      .run(now.toISOString(), this.projectId, GLOBAL_MEMORY_WORKSPACE_ID, before).changes;
  }

  /** The oldest queued job whose memories all belong to this project or to global memory. */
  private next(): JobRow | undefined {
    return this.storage.db
      .prepare<[string, string], JobRow>(
        `SELECT j.turn_id, j.thread_id, t.result_reason
       FROM memory_maintenance_jobs j JOIN turns t ON t.id = j.turn_id
       WHERE j.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.source_turn_id = j.turn_id
           AND m.source_thread_id = j.thread_id AND m.workspace_id NOT IN (?, ?))
       ORDER BY t.completed_at LIMIT 1`,
      )
      .get(this.projectId, GLOBAL_MEMORY_WORKSPACE_ID);
  }

  hasPending(): boolean {
    return this.next() !== undefined;
  }

  private candidates(threadId: string, turnId: string): CandidateMemory[] {
    return this.storage.db
      .prepare<[string, string, string, string, number], CandidateMemory>(
        `SELECT id, scope, category, content, created_at FROM memories
       WHERE source_thread_id = ? AND source_turn_id = ? AND status = 'active'
         AND workspace_id IN (?, ?)
       ORDER BY id LIMIT ?`,
      )
      .all(threadId, turnId, this.projectId, GLOBAL_MEMORY_WORKSPACE_ID, MAX_CANDIDATES);
  }

  private async modelJson(
    jobId: string,
    provider: ModelProvider,
    instruction: string,
    input: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.storage.db
      .prepare("UPDATE memory_maintenance_jobs SET model_requests = model_requests + 1 WHERE turn_id = ?")
      .run(jobId);
    const response = await provider.complete({
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: JSON.stringify(input) },
      ],
      tools: [],
      responseMode: "buffered",
      maxRetries: 0,
      thinkingEffort: "low",
      signal,
    });
    this.storage.db
      .prepare(
        `UPDATE memory_maintenance_jobs
          SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?
        WHERE turn_id = ?`,
      )
      .run(response.usage?.promptTokens ?? 0, response.usage?.completionTokens ?? 0, jobId);
    return parseJsonResponse(response.message.content ?? "");
  }

  async processNext(state: Readonly<SessionState>, provider: ModelProvider, signal?: AbortSignal): Promise<boolean> {
    if (state.activeTurnId || signal?.aborted) return false;
    const job = this.next();
    if (!job) return false;
    const now = new Date().toISOString();
    // Another process open on this project may have claimed the job first.
    const claimed = this.storage.db
      .prepare(
        "UPDATE memory_maintenance_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE turn_id = ? AND status = 'queued'",
      )
      .run(now, job.turn_id).changes;
    if (!claimed) return true;
    try {
      const candidates = this.candidates(job.thread_id, job.turn_id);
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");
      if (!candidates.length) {
        this.complete(job.turn_id);
        return true;
      }
      const matches = await Promise.all(
        candidates.map(async (candidate) => {
          const owner = candidate.scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : this.projectId;
          const found = await this.manager.searchHybrid(owner, candidate.content, {
            limit: this.manager.limits.memoryConsolidationMatchLimit,
            ranking: "consolidation",
            filter: {
              scope: candidate.scope,
              category: candidate.category,
              status: "active",
              excludeMemoryId: candidate.id,
            },
          });
          return found.map((item) => ({
            id: item.id,
            category: item.category,
            content: item.content,
            createdAt: item.createdAt,
          }));
        }),
      );
      if (matches.every((items) => items.length === 0)) {
        this.complete(job.turn_id);
        return true;
      }
      const consolidated = consolidationSchema.parse(
        await this.modelJson(
          job.turn_id,
          provider,
          "Consolidate only memories already created by the agent's write_memory tool. Never create a new memory or change its scope. " +
            'Return only JSON {"decisions":[{"index":0,"action":"merge|conflict|skip","memoryId":"matching existing ID","content":"concise merged statement"}]}. ' +
            "Merge only equivalent or compatible statements and preserve both qualifications: name the matching record to revise and give the merged content; the candidate expires. " +
            "Use conflict, naming the matching record, when the candidate and that record cannot both be true; the older of the two is flagged for verification. " +
            "Skip anything else. Each index appears at most once.",
          {
            candidates: candidates.map(({ created_at: createdAt, ...candidate }, index) => ({
              index,
              ...candidate,
              createdAt,
              matches: matches[index],
            })),
          },
          signal,
        ),
      );
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");

      const seen = new Set<number>();
      const mutations: MemoryMutationRequest[] = [];
      for (const decision of consolidated.decisions) {
        if (seen.has(decision.index)) continue;
        seen.add(decision.index);
        const candidate = candidates[decision.index];
        const match = matches[decision.index]?.find((item) => item.id === decision.memoryId);
        if (!candidate || !match || decision.action === "skip") continue;
        if (decision.action === "conflict") {
          // The newer statement is the likelier one; the older is offered as needing verification.
          const older = match.createdAt < candidate.created_at ? match.id : candidate.id;
          if (mutations.some((mutation) => "memoryId" in mutation && mutation.memoryId === older)) continue;
          if (mutations.length + 1 > MAX_MEMORY_MUTATIONS_PER_TURN) break;
          mutations.push({
            action: "flag",
            memoryId: older,
            scope: candidate.scope,
            reason: "Contradicted by another memory; verify before relying on it",
          });
          continue;
        }
        if (!decision.content || decision.content.length > this.manager.limits.memoryContentMaxChars) continue;
        if (mutations.length + 2 > MAX_MEMORY_MUTATIONS_PER_TURN) break;
        mutations.push({
          action: "revise",
          memoryId: match.id,
          scope: candidate.scope,
          category: candidate.category,
          content: decision.content,
          reason: "Background consolidation of existing memory",
        });
        mutations.push({
          action: "forget",
          memoryId: candidate.id,
          scope: candidate.scope,
          reason: "Merged into an existing compatible memory",
        });
      }
      if (signal?.aborted) throw new Error("Memory maintenance interrupted");
      this.manager.applyModelMutations(
        {
          workspaceId: this.projectId,
          workspaceRoot: state.workspaceRoot,
          threadId: job.thread_id,
          turnId: job.turn_id,
          outcome: job.result_reason,
          mutations,
        },
        () => this.complete(job.turn_id),
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) {
        this.storage.db
          .prepare(
            "UPDATE memory_maintenance_jobs SET status = 'queued', attempts = MAX(0, attempts - 1), updated_at = ? WHERE turn_id = ?",
          )
          .run(new Date().toISOString(), job.turn_id);
        return true;
      }
      this.storage.db
        .prepare(
          "UPDATE memory_maintenance_jobs SET status = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END, error = ?, updated_at = ? WHERE turn_id = ?",
        )
        .run(redactSensitiveInformation(message).slice(0, 500), new Date().toISOString(), job.turn_id);
      return true;
    }
  }

  private complete(turnId: string): void {
    this.storage.db
      .prepare("UPDATE memory_maintenance_jobs SET status = 'done', error = NULL, updated_at = ? WHERE turn_id = ?")
      .run(new Date().toISOString(), turnId);
  }
}
