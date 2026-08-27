import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { createStorage } from "../src/storage/index.js";
import { SqliteDatabase } from "../src/storage/sqlite-database.js";
import {
  deserializeChatMessage,
  EventJournal,
  serializeChatMessage,
  ThreadStore,
} from "../src/threads/index.js";

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-storage-"));
}

async function waitForOutput(
  child: ChildProcess,
  marker: string,
  timeoutMs = 10_000,
): Promise<void> {
  const output = child.stdout;
  if (!output) throw new Error("child stdout is not available");
  await new Promise<void>((resolve, reject) => {
    let collected = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child output ${JSON.stringify(marker)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      collected += chunk.toString();
      if (collected.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`child exited before emitting ${JSON.stringify(marker)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      output.removeListener("data", onData);
      child.removeListener("exit", onExit);
    };
    output.on("data", onData);
    child.once("exit", onExit);
  });
}

describe("storage", () => {
  it("creates and migrates SQLite with the required safety pragmas", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      assert.equal(
        String(storage.db.pragma("journal_mode", { simple: true })).toLowerCase(),
        "delete",
      );
      assert.equal(storage.db.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(storage.db.pragma("busy_timeout", { simple: true }), 5_000);

      const tables = storage.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
        )
        .all()
        .map((row) => row.name);
      for (const required of [
        "threads",
        "turns",
        "item_index",
        "memories",
        "memories_fts",
        "tool_audit",
      ]) {
        assert.ok(tables.includes(required), `missing table ${required}`);
      }

      const reopenedPath = storage.databasePath;
      storage.close();
      const reopened = createStorage(dataDir);
      try {
        assert.equal(reopened.databasePath, reopenedPath);
        assert.equal(
          reopened.db
            .prepare<[], { count: number }>(
              "SELECT COUNT(*) AS count FROM schema_migrations",
            )
            .get()?.count,
          1,
        );
      } finally {
        reopened.close();
      }
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps WASM SQLite transactions synchronous and rolls failures back", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      storage.db.exec("CREATE TABLE transaction_probe(value TEXT NOT NULL)");
      const fail = storage.db.transaction(() => {
        storage.db
          .prepare<[string]>("INSERT INTO transaction_probe(value) VALUES (?)")
          .run("discarded");
        throw new Error("rollback probe");
      });
      assert.throws(fail, /rollback probe/u);
      const row = storage.db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM transaction_probe",
        )
        .get();
      assert.equal(row?.count, 0);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("blocks discarded async transaction continuations after rollback", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      storage.db.exec("CREATE TABLE async_transaction_probe(value TEXT NOT NULL)");
      let continuation: Promise<void> | undefined;
      let continuationError: unknown;
      const fail = storage.db.transaction(() => {
        storage.db
          .prepare<[string]>("INSERT INTO async_transaction_probe(value) VALUES (?)")
          .run("discarded-before-await");
        continuation = (async (): Promise<void> => {
          await Promise.resolve();
          try {
            storage.db
              .prepare<[string]>("INSERT INTO async_transaction_probe(value) VALUES (?)")
              .run("must-not-escape");
          } catch (error) {
            continuationError = error;
          }
        })();
        return continuation;
      });

      assert.throws(fail, /callbacks must be synchronous/u);
      assert.ok(continuation);
      await continuation;
      assert.match(
        continuationError instanceof Error ? continuationError.message : "",
        /no longer active/u,
      );
      assert.equal(
        storage.db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM async_transaction_probe",
          )
          .get()?.count,
        0,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("binds a single Uint8Array as one BLOB parameter", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      storage.db.exec("CREATE TABLE blob_probe(value BLOB NOT NULL)");
      const expected = new Uint8Array([0, 1, 127, 255]);
      storage.db
        .prepare<[Uint8Array]>("INSERT INTO blob_probe(value) VALUES (?)")
        .run(expected);
      const actual = storage.db
        .prepare<[], { value: Uint8Array }>("SELECT value FROM blob_probe")
        .get()?.value;
      assert.ok(actual instanceof Uint8Array);
      assert.deepEqual([...actual], [...expected]);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers crashed locks under concurrent multi-process contention", async () => {
    const dataDir = temporaryDataDir();
    const databasePath = path.join(dataDir, "easy-code.db");
    const advisoryPath = `${databasePath}.easy-code-advisory-lock`;
    const wasmLockPath = `${databasePath}.lock`;
    const storageModule = new URL("../src/storage/index.js", import.meta.url).href;
    const childScript = [
      "const { createStorage } = await import(process.argv[1]);",
      "const storage = createStorage(process.argv[2]);",
      "storage.db.exec('CREATE TABLE crash_probe(value TEXT NOT NULL)');",
      "storage.db.transaction(() => {",
      "  storage.db.prepare('INSERT INTO crash_probe(value) VALUES (?)').run('discarded');",
      "  process.exit(23);",
      "})();",
    ].join("\n");

    try {
      const crashed = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", childScript, storageModule, dataDir],
        { encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(
        crashed.status,
        23,
        `child did not crash at the lock probe:\n${crashed.stderr}`,
      );
      assert.equal(existsSync(advisoryPath), true, "missing crashed advisory lock");
      assert.equal(existsSync(wasmLockPath), true, "missing crashed WASM VFS lock");

      const contenderScript = [
        "const { createStorage } = await import(process.argv[1]);",
        "const storage = createStorage(process.argv[2]);",
        "const row = storage.db.prepare('SELECT COUNT(*) AS count FROM crash_probe').get();",
        "storage.close();",
        "if (row.count !== 0) process.exitCode = 24;",
      ].join("\n");
      const contenders = Array.from({ length: 8 }, () =>
        spawn(
          process.execPath,
          ["--input-type=module", "-e", contenderScript, storageModule, dataDir],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
      );
      const results = await Promise.all(contenders.map(async (child) => {
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        const [code, signal] = await once(child, "exit") as [
          number | null,
          NodeJS.Signals | null,
        ];
        return { code, signal, stderr };
      }));
      for (const result of results) {
        assert.equal(
          result.code,
          0,
          `recovery contender failed (${String(result.signal)}):\n${result.stderr}`,
        );
      }

      const tombstones = readdirSync(dataDir).filter((name) =>
        name.startsWith("easy-code.db.easy-code-advisory-lock.stale-"),
      );
      assert.equal(tombstones.length, 1, "expected one fixed stale-owner tombstone");
      assert.equal(
        existsSync(path.join(dataDir, tombstones[0] as string, "recovered.json")),
        true,
        "stale owner was not marked recovered",
      );

      const recovered = createStorage(dataDir);
      try {
        assert.equal(existsSync(advisoryPath), false);
        assert.equal(existsSync(wasmLockPath), false);
        assert.equal(
          recovered.db
            .prepare<[], { count: number }>(
              "SELECT COUNT(*) AS count FROM crash_probe",
            )
            .get()?.count,
          0,
        );
      } finally {
        recovered.close();
      }
      assert.equal(existsSync(advisoryPath), false);
      assert.equal(existsSync(wasmLockPath), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("never removes the WASM lock of a live advisory-lock owner", async () => {
    const dataDir = temporaryDataDir();
    const databasePath = path.join(dataDir, "easy-code.db");
    const advisoryPath = `${databasePath}.easy-code-advisory-lock`;
    const wasmLockPath = `${databasePath}.lock`;
    const storageModule = new URL("../src/storage/index.js", import.meta.url).href;
    const childScript = [
      "const { createStorage } = await import(process.argv[1]);",
      "const storage = createStorage(process.argv[2]);",
      "storage.db.exec('CREATE TABLE live_lock_probe(value TEXT)');",
      "storage.db.transaction(() => {",
      "  process.stdout.write('EASY_CODE_LOCKED\\n');",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);",
      "})();",
      "storage.close();",
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childScript, storageModule, dataDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    try {
      await waitForOutput(child, "EASY_CODE_LOCKED\n");
      assert.equal(existsSync(advisoryPath), true);
      assert.equal(existsSync(wasmLockPath), true);
      assert.throws(
        () => new SqliteDatabase(databasePath, { lockTimeoutMs: 100 }),
        /database is busy.*pid/iu,
      );
      assert.equal(existsSync(advisoryPath), true);
      assert.equal(existsSync(wasmLockPath), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }

    try {
      const recovered = createStorage(dataDir);
      recovered.close();
      assert.equal(existsSync(advisoryPath), false);
      assert.equal(existsSync(wasmLockPath), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not create advisory files for an in-memory database", () => {
    const unexpectedLock = `${path.resolve(":memory:")}.easy-code-advisory-lock`;
    assert.equal(existsSync(unexpectedLock), false);
    const database = new SqliteDatabase(":memory:");
    try {
      database.exec("SELECT 1");
    } finally {
      database.close();
    }
    assert.equal(existsSync(unexpectedLock), false);
  });

  it("rejects a stale tombstone whose basename token disagrees with its owner", () => {
    const dataDir = temporaryDataDir();
    const databasePath = path.join(dataDir, "easy-code.db");
    const advisoryPath = `${databasePath}.easy-code-advisory-lock`;
    const ownerToken = "a".repeat(32);
    const mismatchedToken = "b".repeat(32);
    const tombstonePath = `${advisoryPath}.stale-${mismatchedToken}`;
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(exited.status, 0);
    mkdirSync(tombstonePath);
    writeFileSync(
      path.join(tombstonePath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: exited.pid,
        hostname: os.hostname(),
        token: ownerToken,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    try {
      assert.throws(
        () => new SqliteDatabase(databasePath, { lockTimeoutMs: 250 }),
        /does not match its owner token/u,
      );
      assert.equal(existsSync(tombstonePath), true);
      assert.equal(existsSync(advisoryPath), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses one reentrant advisory lock through a directory alias", () => {
    const dataDir = temporaryDataDir();
    const realDirectory = path.join(dataDir, "real");
    const aliasDirectory = path.join(dataDir, "alias");
    mkdirSync(realDirectory);
    symlinkSync(
      realDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const primary = new SqliteDatabase(path.join(realDirectory, "alias.db"));
    const alias = new SqliteDatabase(
      path.join(aliasDirectory, "alias.db"),
      { lockTimeoutMs: 100 },
    );

    try {
      primary.exec("CREATE TABLE alias_probe(value INTEGER NOT NULL)");
      assert.strictEqual(
        (primary as unknown as { advisoryLock: unknown }).advisoryLock,
        (alias as unknown as { advisoryLock: unknown }).advisoryLock,
      );
    } finally {
      alias.close();
      primary.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses symlink, non-directory, and non-empty WASM lock targets", () => {
    for (const kind of ["symlink", "file", "nonempty"] as const) {
      const dataDir = temporaryDataDir();
      const databasePath = path.join(dataDir, "easy-code.db");
      const advisoryPath = `${databasePath}.easy-code-advisory-lock`;
      const wasmLockPath = `${databasePath}.lock`;
      const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      assert.equal(exited.status, 0);
      mkdirSync(advisoryPath);
      writeFileSync(
        path.join(advisoryPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          pid: exited.pid,
          hostname: os.hostname(),
          token: "a".repeat(32),
          acquiredAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );

      if (kind === "file") {
        writeFileSync(wasmLockPath, "not a directory", "utf8");
      } else if (kind === "nonempty") {
        mkdirSync(wasmLockPath);
        writeFileSync(path.join(wasmLockPath, "sentinel"), "keep", "utf8");
      } else {
        const target = path.join(dataDir, "lock-target");
        mkdirSync(target);
        symlinkSync(target, wasmLockPath, process.platform === "win32" ? "junction" : "dir");
      }

      try {
        assert.throws(
          () => new SqliteDatabase(databasePath, { lockTimeoutMs: 250 }),
          kind === "nonempty" ? /non-empty SQLite lock/u : /not a plain directory/u,
        );
        assert.equal(existsSync(wasmLockPath), true);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  it("appends sequenced JSONL events and repairs a damaged tail", () => {
    const dataDir = temporaryDataDir();
    try {
      const journal = new EventJournal(dataDir, "thread_journal");
      assert.equal(journal.append({ type: "one", payload: { value: 1 } }).sequence, 1);
      assert.equal(journal.append({ type: "two", payload: { value: 2 } }).sequence, 2);
      appendFileSync(journal.filePath, '{"schemaVersion":1,"broken":', "utf8");

      assert.deepEqual(journal.read().map((event) => event.type), ["one", "two"]);
      const third = journal.append({ type: "three", payload: null });
      assert.equal(third.sequence, 3);
      assert.deepEqual(journal.read().map((event) => event.sequence), [1, 2, 3]);
      assert.equal(journal.readAfter(1).length, 2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("serializes ChatMessage and recovers threads from the journal", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const assistantMessage = {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
          },
        ],
      };
      assert.deepEqual(
        deserializeChatMessage(serializeChatMessage(assistantMessage)),
        assistantMessage,
      );

      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_restore",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
        goal: "test recovery",
        messages: [{ role: "user", content: "hello" }, assistantMessage],
      });
      state.mode = "code";
      state.workingSummary = "verified summary";
      state.filesRead.set("src/a.ts", {
        path: "src/a.ts",
        hash: "abc",
        readAt: new Date().toISOString(),
      });
      threads.save(state);

      const turn = threads.startTurn("thread_restore", "continue");
      threads.completeTurn(
        "thread_restore",
        turn.turnId,
        { role: "assistant", content: "done" },
      );

      const recovered = threads.recover("thread_restore");
      assert.equal(recovered.mode, "code");
      assert.equal(recovered.workingSummary, "verified summary");
      assert.equal(recovered.filesRead.get("src/a.ts")?.hash, "abc");
      assert.deepEqual(recovered.messages.slice(-2), [
        { role: "user", content: "continue" },
        { role: "assistant", content: "done" },
      ]);
      assert.equal(threads.list()[0]?.threadId, "thread_restore");

      // SQLite is a projection: deleting it must not destroy the recoverable
      // thread. A journal recovery rebuilds the missing projection rows.
      storage.db.prepare("DELETE FROM threads WHERE id = ?").run("thread_restore");
      assert.equal(threads.list().length, 0);
      assert.equal(threads.rebuildProjection("thread_restore").workingSummary, "verified summary");
      assert.equal(threads.list()[0]?.threadId, "thread_restore");

      const indexed = storage.db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM item_index WHERE thread_id = 'thread_restore'",
        )
        .get();
      assert.equal(indexed?.count, 4);
      assert.equal(
        storage.db
          .prepare<[string], { status: string }>(
            "SELECT status FROM turns WHERE id = ?",
          )
          .get(turn.turnId)?.status,
        "completed",
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("projects runtime-shaped turns and tool audits while keeping JSONL recoverable", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_runtime_events",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-test",
      });
      threads.appendEvent("thread_runtime_events", {
        type: "message.user",
        turnId: "turn_runtime",
        phase: "completed",
        payload: { content: "inspect the project" },
      });
      threads.appendEvent("thread_runtime_events", {
        type: "message.assistant",
        turnId: "turn_runtime",
        phase: "completed",
        payload: { role: "assistant", content: "done" },
      });
      threads.completeTurn(
        "thread_runtime_events",
        "turn_runtime",
        { role: "assistant", content: "done" },
      );
      threads.recordToolAudit("thread_runtime_events", "turn_runtime", {
        id: "command_1",
        program: "node",
        args: ["--version"],
        cwd: path.join(dataDir, "workspace"),
        status: "exited",
        exitCode: 0,
        durationMs: 5,
        timestamp: new Date().toISOString(),
        summary: "node version",
      });

      const recovered = threads.recover("thread_runtime_events");
      assert.deepEqual(recovered.messages, [
        { role: "user", content: "inspect the project" },
        { role: "assistant", content: "done" },
      ]);
      assert.equal(
        storage.db
          .prepare<[], { status: string }>(
            "SELECT status FROM turns WHERE id = 'turn_runtime'",
          )
          .get()?.status,
        "completed",
      );
      assert.equal(
        storage.db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM tool_audit WHERE id = 'command_1'",
          )
          .get()?.count,
        1,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers the exact bounded tool message and runtime turn completion", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_bounded_tool",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen-test",
      });
      const turnId = "turn_bounded";
      threads.appendEvent("thread_bounded_tool", {
        type: "message.user",
        turnId,
        payload: { content: "read it" },
      });
      threads.appendEvent("thread_bounded_tool", {
        type: "message.assistant",
        turnId,
        payload: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_bounded",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          }],
        },
      });
      const boundedToolMessage = {
        role: "tool" as const,
        tool_call_id: "call_bounded",
        name: "read_file",
        content: '{"ok":true,"summary":"bounded"}',
      };
      threads.appendEvent("thread_bounded_tool", {
        type: "tool.result",
        turnId,
        payload: {
          callId: "call_bounded",
          tool: "read_file",
          message: boundedToolMessage,
        },
      });
      threads.appendEvent("thread_bounded_tool", {
        type: "message.assistant",
        turnId,
        payload: { role: "assistant", content: "done" },
      });
      threads.appendEvent("thread_bounded_tool", {
        type: "turn.completed",
        turnId,
        payload: { reason: "success", steps: 2 },
      });

      const recovered = threads.recover("thread_bounded_tool");
      assert.deepEqual(recovered.messages[2], boundedToolMessage);
      assert.equal(recovered.activeTurnId, undefined);
      assert.equal(
        storage.db
          .prepare<[string], { status: string }>("SELECT status FROM turns WHERE id = ?")
          .get(turnId)?.status,
        "completed",
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
