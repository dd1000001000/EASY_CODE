import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import type { ModelProvider } from "../src/core/types.js";
import { MemoryMaintenance } from "../src/memory/maintenance.js";
import { MemoryManager, GLOBAL_MEMORY_WORKSPACE_ID, projectMemoryIdFromRoot } from "../src/memory/memory-manager.js";
import { defaultRuntimeLimits, type RuntimeLimits } from "../src/config/runtime-limits.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";

function fixture(userInput = "Inspect the project", limits: Readonly<RuntimeLimits> = defaultRuntimeLimits()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-maint-"));
  const storage = createStorage(path.join(root, "data"));
  const store = new ThreadStore(storage);
  const state = store.create({
    threadId: "thread_memory_maintenance",
    workspaceRoot: root,
    mode: "code",
    provider: "deepseek",
    model: "test",
    thinkingEffort: "low",
  });
  const { turnId } = store.startTurn(state.threadId, userInput);
  store.completeTurn(state.threadId, turnId, { role: "assistant", content: "Done." }, "success");
  const manager = new MemoryManager(storage, { limits });
  const maintenance = new MemoryMaintenance(storage, manager, root);
  const write = (content: string, turn = turnId, scope: "project" | "global" = "project") =>
    manager.applyModelMutations({
      workspaceRoot: root,
      threadId: state.threadId,
      turnId: turn,
      outcome: "success",
      mutations: [
        { action: "remember", scope, category: "convention", content, reason: "Agent-selected durable memory" },
      ],
    }).memoryIds[0]!;
  const enqueue = () => maintenance.enqueueCompleted(new Date(Date.now() + 3 * 60_000));
  return {
    root,
    storage,
    store,
    state,
    turnId,
    manager,
    maintenance,
    write,
    enqueue,
    dispose() {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function model(...answers: string[]): ModelProvider & { calls: number } {
  let calls = 0;
  return {
    name: "deepseek",
    model: "test",
    get calls() {
      return calls;
    },
    async complete() {
      const answer = answers[calls++];
      if (answer === undefined) throw new Error("Unexpected maintenance model call");
      return { message: { role: "assistant", content: answer } };
    },
  };
}

describe("idle memory maintenance", () => {
  it("never creates memory from a completed turn without a write_memory proposal", async () => {
    const f = fixture("以后所有项目的回答都要简洁，用中文说明。");
    try {
      const provider = model();
      assert.equal(f.enqueue(), 0);
      assert.equal(await f.maintenance.processNext(f.state, provider), false);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.list(GLOBAL_MEMORY_WORKSPACE_ID).length, 0);
    } finally {
      f.dispose();
    }
  });

  it("keeps a single agent-written memory without another model request", async () => {
    const f = fixture("Please use concise explanations.");
    try {
      const id = f.write("Use concise explanations across projects.", f.turnId, "global");
      const provider = model();
      assert.equal(f.enqueue(), 1);
      assert.equal(await f.maintenance.processNext(f.state, provider), true);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.get(GLOBAL_MEMORY_WORKSPACE_ID, id)?.status, "active");
      assert.deepEqual(
        f.storage.db
          .prepare<[string], { status: string; model_requests: number }>(
            "SELECT status, model_requests FROM memory_maintenance_jobs WHERE turn_id = ?",
          )
          .get(f.turnId),
        { status: "done", model_requests: 0 },
      );
    } finally {
      f.dispose();
    }
  });

  it("merges compatible memories only within the chosen scope", async () => {
    const f = fixture("Inspect the project", {
      ...defaultRuntimeLimits(),
      memoryConsolidationMatchLimit: 2,
    });
    try {
      const search = f.manager.searchHybrid.bind(f.manager);
      const observedLimits: number[] = [];
      const observedOptions: Array<Record<string, unknown>> = [];
      f.manager.searchHybrid = async (workspaceId, query, options = {}) => {
        observedLimits.push(typeof options === "number" ? options : (options.limit ?? 0));
        if (typeof options !== "number") observedOptions.push(options as unknown as Record<string, unknown>);
        return search(workspaceId, query, options);
      };
      const oldId = f.write("This project uses strict TypeScript.", "turn_seed");
      const candidateId = f.write("This project uses ESLint and strict TypeScript.");
      const provider = model(
        JSON.stringify({
          decisions: [
            { index: 0, action: "merge", memoryId: oldId, content: "This project uses strict TypeScript and ESLint." },
          ],
        }),
      );
      f.enqueue();
      assert.equal(await f.maintenance.processNext(f.state, provider), true);
      assert.equal(provider.calls, 1);
      assert.deepEqual(observedLimits, [2]);
      assert.equal(observedOptions[0]?.ranking, "consolidation");
      assert.deepEqual(observedOptions[0]?.filter, {
        scope: "project",
        category: "convention",
        status: "active",
        excludeMemoryId: candidateId,
      });
      assert.equal(f.manager.get(projectMemoryIdFromRoot(f.root), oldId)?.status, "superseded");
      const active = f.manager.list(projectMemoryIdFromRoot(f.root));
      assert.equal(active.length, 1);
      assert.match(active[0]!.content, /ESLint/u);
    } finally {
      f.dispose();
    }
  });

  it("flags the older of two contradicting memories for verification", async () => {
    const f = fixture();
    try {
      const oldId = f.write("This project formats code with tabs.", "turn_seed");
      const newId = f.write("This project formats code with two spaces.");
      f.storage.db
        .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 86_400_000).toISOString(), oldId);
      f.enqueue();
      const provider = model(JSON.stringify({ decisions: [{ index: 0, action: "conflict", memoryId: oldId }] }));
      assert.equal(await f.maintenance.processNext(f.state, provider), true);
      const projectId = projectMemoryIdFromRoot(f.root);
      assert.equal(f.manager.get(projectId, oldId)?.status, "needs_verification");
      assert.equal(f.manager.get(projectId, newId)?.status, "active");
      // A flagged memory is still offered, marked, so the agent can confirm or forget it.
      assert.equal(f.manager.list(projectId, { status: "needs_verification" }).length, 1);
    } finally {
      f.dispose();
    }
  });

  it("consolidates memory written in another conversation of the same project", async () => {
    const f = fixture();
    try {
      const other = f.store.create({
        threadId: "thread_other_conversation",
        workspaceRoot: f.root,
        mode: "code",
        provider: "deepseek",
        model: "test",
        thinkingEffort: "low",
      });
      const { turnId } = f.store.startTurn(other.threadId, "Add linting");
      f.store.completeTurn(other.threadId, turnId, { role: "assistant", content: "Done." }, "success");
      const oldId = f.write("This project uses strict TypeScript.", "turn_seed");
      const candidateId = f.manager.applyModelMutations({
        workspaceRoot: f.root,
        threadId: other.threadId,
        turnId,
        outcome: "success",
        mutations: [
          {
            action: "remember",
            category: "convention",
            content: "This project uses ESLint and strict TypeScript.",
            reason: "Agent-selected durable memory",
          },
        ],
      }).memoryIds[0]!;
      f.enqueue();
      const provider = model(
        JSON.stringify({
          decisions: [
            { index: 0, action: "merge", memoryId: oldId, content: "This project uses strict TypeScript and ESLint." },
          ],
        }),
      );
      // The idle process is in the first conversation; the job belongs to the other one.
      assert.equal(await f.maintenance.processNext(f.state, provider), true);
      assert.equal(provider.calls, 1);
      assert.equal(f.manager.get(projectMemoryIdFromRoot(f.root), candidateId)?.status, "expired");
    } finally {
      f.dispose();
    }
  });

  it("requeues only jobs left running by a process that stopped", () => {
    const f = fixture();
    try {
      f.write("This project uses strict TypeScript.");
      f.enqueue();
      const now = new Date("2026-10-02T12:00:00.000Z");
      const setRunning = (updatedAt: string) =>
        f.storage.db
          .prepare("UPDATE memory_maintenance_jobs SET status = 'running', updated_at = ? WHERE turn_id = ?")
          .run(updatedAt, f.turnId);
      const status = () =>
        f.storage.db
          .prepare<[string], { status: string }>("SELECT status FROM memory_maintenance_jobs WHERE turn_id = ?")
          .get(f.turnId)?.status;
      setRunning("2026-10-02T11:55:00.000Z");
      f.maintenance.recover(now);
      assert.equal(status(), "running");
      setRunning("2026-10-02T11:30:00.000Z");
      f.maintenance.recover(now);
      assert.equal(status(), "queued");
    } finally {
      f.dispose();
    }
  });

  it("does not merge the same statement across project and global scope", async () => {
    const f = fixture();
    try {
      f.write("Use strict TypeScript across projects.", "turn_seed", "global");
      f.write("Use strict TypeScript across projects.");
      const provider = model();
      f.enqueue();
      await f.maintenance.processNext(f.state, provider);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 1);
      assert.equal(f.manager.list(GLOBAL_MEMORY_WORKSPACE_ID).length, 1);
    } finally {
      f.dispose();
    }
  });

  it("requeues a failed consolidation without adding new memories", async () => {
    const f = fixture();
    try {
      const oldId = f.write("This project uses strict TypeScript.", "turn_seed");
      f.write("This project uses ESLint and strict TypeScript.");
      f.enqueue();
      await f.maintenance.processNext(f.state, model("not-json"));
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 2);
      assert.equal(
        f.storage.db
          .prepare<[string], { status: string }>("SELECT status FROM memory_maintenance_jobs WHERE turn_id = ?")
          .get(f.turnId)?.status,
        "queued",
      );
      await f.maintenance.processNext(
        f.state,
        model(
          JSON.stringify({
            decisions: [
              {
                index: 0,
                action: "merge",
                memoryId: oldId,
                content: "This project uses strict TypeScript and ESLint.",
              },
            ],
          }),
        ),
      );
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 1);
    } finally {
      f.dispose();
    }
  });
});
