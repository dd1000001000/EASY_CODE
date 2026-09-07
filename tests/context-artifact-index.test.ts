import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ContextArtifactIndex,
  renderContextCheckpoint,
  renderRetrievedContext,
} from "../src/context/artifact-index.js";
import type { SessionState } from "../src/core/types.js";
import type { EmbeddingProvider } from "../src/memory/vector-index.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

const WORKSPACE_ID = "workspace_context_index";

class KeywordEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 3;
  readonly model = "test/context-embedding";
  readonly revision = "revision-one";
  readonly pooling = "masked-mean";
  readonly version = 1;
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      if (/deploy|release|blue-green/iu.test(text)) return Float32Array.from([1, 0, 0]);
      if (/database|sqlite|schema/iu.test(text)) return Float32Array.from([0, 1, 0]);
      return Float32Array.from([0, 0, 1]);
    });
  }
}

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-context-index-"));
}

function createState(store: ThreadStore, threadId: string): SessionState {
  return store.create({
    threadId,
    workspaceRoot: process.cwd(),
    mode: "code",
    provider: "deepseek",
    model: "test-model",
    thinkingEffort: "high",
  });
}

describe("layered Thread context index", () => {
  it("indexes only the appended suffix and restores hybrid evidence after resume", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const store = new ThreadStore(storage);
      const state = createState(store, "thread_context_a");
      state.goal = "Prepare the release";
      state.messages.push(
        { role: "user", content: "Use a blue-green deployment for the release." },
        {
          role: "assistant",
          content: "I will inspect the database migration first.",
          reasoning_content: "private chain of thought must not enter the retrieval corpus",
        },
        {
          role: "tool",
          name: "read_file",
          tool_call_id: "call_read_schema",
          content: JSON.stringify({
            ok: true,
            summary: "Read src/schema.ts lines 1-2",
            data: {
              path: "src/schema.ts",
              startLine: 1,
              endLine: 2,
              content: "export const schemaVersion = 5;\n// blue-green release metadata",
            },
          }),
        },
      );
      const provider = new KeywordEmbeddingProvider();
      const firstIndex = new ContextArtifactIndex(storage, provider);
      const first = await firstIndex.checkpoint(WORKSPACE_ID, state);
      assert.equal(first.indexedMessages, 3);
      assert.equal(first.indexedChunks, 3);
      assert.equal(first.checkpoint.sequence, 1);

      const unchanged = await firstIndex.checkpoint(WORKSPACE_ID, state);
      assert.equal(unchanged.indexedMessages, 0);
      assert.equal(unchanged.indexedChunks, 0);
      assert.equal(unchanged.checkpoint.sequence, 1);

      state.messages.push({ role: "user", content: "Now verify the rollback path." });
      const appended = await firstIndex.checkpoint(WORKSPACE_ID, state);
      assert.equal(appended.indexedMessages, 1);
      assert.equal(appended.checkpoint.sequence, 2);

      // A fresh projection object simulates process resume. SQLite remains the
      // source of truth while its Orama cache is rebuilt lazily.
      const resumed = new ContextArtifactIndex(storage, provider);
      const hits = await resumed.search(
        WORKSPACE_ID,
        state.threadId,
        "How is the release deployed?",
        { beforeMessageIndex: 3, limit: 4 },
      );
      assert.ok(hits.some((hit) => /blue-green deployment/iu.test(hit.content)));
      assert.ok(hits.some((hit) => hit.title === "Read src/schema.ts:1-2"));
      assert.match(renderRetrievedContext(hits), /content_hash=[a-f0-9]{64}/u);

      const checkpoint = resumed.getCheckpoint(state.threadId);
      assert.equal(checkpoint?.indexedMessageCount, 4);
      const rendered = renderContextCheckpoint(checkpoint);
      assert.match(rendered, /"objective": "Prepare the release"/u);
      assert.doesNotMatch(rendered, /private chain of thought/iu);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps Thread evidence isolated and falls back to FTS5 when vectors fail", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const store = new ThreadStore(storage);
      const stateA = createState(store, "thread_context_fallback_a");
      stateA.messages.push({
        role: "user",
        content: "The database uses SQLite WAL checkpoints. token=super-secret-value",
      });
      const stateB = createState(store, "thread_context_fallback_b");
      stateB.messages.push({ role: "user", content: "Use a completely separate database." });

      let vectorFailureCount = 0;
      const unavailableProvider: EmbeddingProvider = {
        dimension: 3,
        model: "test/unavailable",
        revision: "revision-one",
        pooling: "mean",
        version: 1,
        embed: async () => {
          throw new Error("local embedding model unavailable");
        },
      };
      const index = new ContextArtifactIndex(storage, unavailableProvider, () => {
        vectorFailureCount += 1;
      });
      await index.checkpoint(WORKSPACE_ID, stateA);
      await index.checkpoint(WORKSPACE_ID, stateB);

      const hitsA = await index.search(
        WORKSPACE_ID,
        stateA.threadId,
        "SQLite WAL",
        { beforeMessageIndex: 1 },
      );
      assert.equal(hitsA.length, 1);
      assert.match(hitsA[0]?.content ?? "", /SQLite WAL/iu);
      assert.doesNotMatch(hitsA[0]?.content ?? "", /super-secret-value/u);
      assert.ok(vectorFailureCount >= 1);

      await index.search(
        WORKSPACE_ID,
        stateA.threadId,
        "SQLite WAL",
        { beforeMessageIndex: 1 },
      );
      assert.equal(vectorFailureCount, 1);

      const hitsB = await index.search(
        WORKSPACE_ID,
        stateB.threadId,
        "SQLite WAL",
        { beforeMessageIndex: 1 },
      );
      assert.equal(hitsB.some((hit) => /WAL checkpoints/iu.test(hit.content)), false);
      assert.equal(
        vectorFailureCount,
        2,
        "a vector failure in one private Thread must not disable another Thread",
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finds older Chinese evidence through lexical fallback without recency leakage", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const state = createState(new ThreadStore(storage), "thread_context_cjk");
      state.messages.push({ role: "user", content: "数据库迁移采用蓝绿发布策略。" });
      for (let index = 1; index < 35; index += 1) {
        state.messages.push({ role: "assistant", content: `普通日志记录 ${String(index)}` });
      }
      const index = new ContextArtifactIndex(storage, {
        dimension: 3,
        model: "test/unavailable-cjk",
        revision: "revision-one",
        pooling: "mean",
        version: 1,
        embed: async () => {
          throw new Error("local embedding model unavailable");
        },
      });
      await index.checkpoint(WORKSPACE_ID, state);

      const hits = await index.search(
        WORKSPACE_ID,
        state.threadId,
        "迁移",
        { beforeMessageIndex: state.messages.length, limit: 4 },
      );
      assert.equal(hits.some((hit) => hit.messageIndex === 0), true);
      assert.equal(hits.some((hit) => /普通日志记录/u.test(hit.content)), false);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("omits command arguments and raw reasoning from deterministic checkpoints", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const state = createState(new ThreadStore(storage), "thread_context_sensitive");
      state.messages.push({
        role: "assistant",
        content: "The command completed.",
        reasoning_content: "hidden reasoning",
        tool_calls: [{
          id: "call_sensitive",
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              command: ["node", "--api-key", "secret-tool-call-argument"],
            }),
          },
        }],
      });
      state.commands.push({
        id: "command_sensitive",
        program: "node",
        args: ["--api-key", "secret-command-argument"],
        cwd: process.cwd(),
        status: "exited",
        exitCode: 0,
        durationMs: 10,
        timestamp: new Date().toISOString(),
        summary: "Completed without exposing credentials.",
      });
      const index = new ContextArtifactIndex(storage, new KeywordEmbeddingProvider());
      const checkpoint = await index.checkpoint(WORKSPACE_ID, state);
      const rendered = renderContextCheckpoint(checkpoint.checkpoint);
      assert.doesNotMatch(rendered, /secret-command-argument/u);
      const indexedAssistant = storage.db.prepare<[], { content: string }>(
        "SELECT content FROM context_artifacts WHERE source_type = 'assistant'",
      ).get()?.content ?? "";
      assert.match(indexedAssistant, /Requested tools: run_command/u);
      assert.doesNotMatch(indexedAssistant, /secret-tool-call-argument/u);
      assert.doesNotMatch(rendered, /hidden reasoning/u);
      assert.match(rendered, /Completed without exposing credentials/u);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("allows a Thread with derived context rows to be deleted", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const state = createState(new ThreadStore(storage), "thread_context_delete");
      state.messages.push({ role: "user", content: "Index this disposable evidence." });
      const index = new ContextArtifactIndex(storage, new KeywordEmbeddingProvider());
      await index.checkpoint(WORKSPACE_ID, state);
      await index.search(WORKSPACE_ID, state.threadId, "disposable evidence", {
        beforeMessageIndex: state.messages.length,
      });
      const embeddingCountBeforeDelete = storage.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM context_artifact_embeddings",
      ).get()?.count ?? 0;
      assert.ok(embeddingCountBeforeDelete > 0);

      assert.doesNotThrow(() => {
        storage.db.prepare("DELETE FROM threads WHERE id = ?").run(state.threadId);
      });
      const artifactCount = storage.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM context_artifacts",
      ).get()?.count ?? -1;
      const vectorStateCount = storage.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM context_vector_state",
      ).get()?.count ?? -1;
      const embeddingCount = storage.db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM context_artifact_embeddings",
      ).get()?.count ?? -1;
      assert.equal(artifactCount, 0);
      assert.equal(vectorStateCount, 0);
      assert.equal(embeddingCount, 0);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
