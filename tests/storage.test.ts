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
import { repairInterruptedTurn } from "../src/app.js";
import { describe, it } from "./harness.js";
import { createStorage } from "../src/storage/index.js";
import { SqliteDatabase } from "../src/storage/sqlite-database.js";
import {
  deserializeChatMessage,
  deserializeSessionState,
  EventJournal,
  MAX_SERIALIZED_THREAD_CHECKPOINT_DELTA_BYTES,
  serializeChatMessage,
  serializeSessionState,
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
        "memory_embeddings",
        "memory_vector_state",
        "context_artifacts",
        "context_artifacts_fts",
        "context_artifact_embeddings",
        "context_vector_state",
        "context_checkpoints",
        "tool_audit",
        "thread_leases",
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
            8,
        );
        assert.equal(reopened.db.pragma("user_version", { simple: true }), 8);
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

  it("reuses a file-identity cache but rescans external appends before sequencing", () => {
    const dataDir = temporaryDataDir();
    try {
      const journal = new EventJournal(dataDir, "thread_journal_cache");
      journal.append({
        type: "one",
        eventId: "event_cache_one",
        payload: { value: 1 },
      });
      assert.deepEqual(journal.read().map((event) => event.sequence), [1]);
      const firstCache = (journal as unknown as { cachedScan?: unknown }).cachedScan;
      assert.ok(firstCache);
      journal.read();
      assert.strictEqual(
        (journal as unknown as { cachedScan?: unknown }).cachedScan,
        firstCache,
      );

      appendFileSync(journal.filePath, `${JSON.stringify({
        schemaVersion: 1,
        eventId: "event_cache_external",
        threadId: "thread_journal_cache",
        sequence: 2,
        timestamp: "2026-09-06T12:00:00.000Z",
        type: "external",
        payload: { value: 2 },
      })}\n`, "utf8");
      assert.deepEqual(journal.read().map((event) => event.type), ["one", "external"]);
      assert.notStrictEqual(
        (journal as unknown as { cachedScan?: unknown }).cachedScan,
        firstCache,
      );
      assert.throws(
        () => journal.append({
          type: "duplicate",
          eventId: "event_cache_external",
          payload: null,
        }),
        /Duplicate event id/u,
      );

      appendFileSync(journal.filePath, '{"schemaVersion":1,"broken":', "utf8");
      const local = journal.append({ type: "local", payload: { value: 3 } });
      assert.equal(local.sequence, 3);
      assert.deepEqual(journal.read().map((event) => event.sequence), [1, 2, 3]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("serializes direct ThreadStore journal appends across processes", async () => {
    const dataDir = temporaryDataDir();
    const threadId = "thread_concurrent_journal";
    const storageModule = new URL("../src/storage/index.js", import.meta.url).href;
    const threadsModule = new URL("../src/threads/index.js", import.meta.url).href;
    const workerCount = 4;
    const eventsPerWorker = 12;
    const initial = createStorage(dataDir);
    try {
      new ThreadStore(initial).create({
        threadId,
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
      });
    } finally {
      initial.close();
    }

    const childScript = [
      "const { createStorage } = await import(process.argv[1]);",
      "const { ThreadStore } = await import(process.argv[2]);",
      "const storage = createStorage(process.argv[3]);",
      "const threads = new ThreadStore(storage);",
      "for (let index = 0; index < Number(process.argv[6]); index += 1) {",
      "  threads.appendEvent(process.argv[4], {",
      "    type: 'concurrent_probe',",
      "    payload: { worker: process.argv[5], index },",
      "  });",
      "}",
      "storage.close();",
    ].join("\n");

    try {
      const workers = Array.from({ length: workerCount }, (_, index) =>
        spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            childScript,
            storageModule,
            threadsModule,
            dataDir,
            threadId,
            String(index),
            String(eventsPerWorker),
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
      );
      const results = await Promise.all(workers.map(async (child) => {
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
          `journal worker failed (${String(result.signal)}):\n${result.stderr}`,
        );
      }

      const reopened = createStorage(dataDir);
      try {
        const events = new ThreadStore(reopened).journal(threadId).read();
        const expectedCount = 1 + workerCount * eventsPerWorker;
        assert.equal(events.length, expectedCount);
        assert.deepEqual(
          events.map((event) => event.sequence),
          Array.from({ length: expectedCount }, (_, index) => index + 1),
        );
        assert.equal(
          reopened.db
            .prepare<[string], { count: number }>(
              "SELECT COUNT(*) AS count FROM item_index WHERE thread_id = ?",
            )
            .get(threadId)?.count,
          expectedCount,
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enforces exclusive thread leases and releases them normally", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_lease_normal",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
      });
      const first = threads.acquireThreadLease("thread_lease_normal");
      assert.throws(
        () => threads.acquireThreadLease("thread_lease_normal"),
        /already active.*PID/iu,
      );
      threads.releaseThreadLease(first);
      const second = threads.acquireThreadLease("thread_lease_normal");
      assert.notEqual(second.ownerToken, first.ownerToken);
      threads.releaseThreadLease(second);
      assert.equal(
        storage.db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_leases",
          )
          .get()?.count,
        0,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("blocks a live cross-process thread owner and recovers after that process dies", async () => {
    const dataDir = temporaryDataDir();
    const threadId = "thread_lease_process";
    const storageModule = new URL("../src/storage/index.js", import.meta.url).href;
    const threadsModule = new URL("../src/threads/index.js", import.meta.url).href;
    const setup = createStorage(dataDir);
    try {
      new ThreadStore(setup).create({
        threadId,
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
      });
    } finally {
      setup.close();
    }
    const childScript = [
      "const { createStorage } = await import(process.argv[1]);",
      "const { ThreadStore } = await import(process.argv[2]);",
      "const storage = createStorage(process.argv[3]);",
      "new ThreadStore(storage).acquireThreadLease(process.argv[4]);",
      "process.stdout.write('EASY_CODE_THREAD_LEASED\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
    ].join("\n");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        childScript,
        storageModule,
        threadsModule,
        dataDir,
        threadId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let contender: ReturnType<typeof createStorage> | undefined;
    try {
      await waitForOutput(child, "EASY_CODE_THREAD_LEASED\n");
      contender = createStorage(dataDir);
      const threads = new ThreadStore(contender);
      assert.throws(
        () => threads.acquireThreadLease(threadId),
        new RegExp(`already active.*PID ${child.pid}`, "iu"),
      );

      const exited = once(child, "exit");
      assert.equal(child.kill(), true);
      await exited;
      const recovered = threads.acquireThreadLease(threadId);
      assert.equal(recovered.ownerPid, process.pid);
      threads.releaseThreadLease(recovered);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      contender?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers a dead-PID lease without allowing the stale token to delete its replacement", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_lease_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
      });
      const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      assert.equal(exited.status, 0);
      assert.ok(exited.pid);
      const stale = threads.acquireThreadLease("thread_lease_recovery", {
        processId: exited.pid,
      });
      const replacement = threads.acquireThreadLease("thread_lease_recovery", {
        isProcessAlive: (processId) => {
          assert.equal(processId, exited.pid);
          return false;
        },
      });

      assert.throws(
        () => threads.releaseThreadLease(stale),
        /ownership no longer matches/u,
      );
      assert.throws(
        () => threads.acquireThreadLease("thread_lease_recovery"),
        /already active/u,
      );
      threads.releaseThreadLease(replacement);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not steal a lease owned on another host", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_lease_remote",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen-test",
      });
      const remote = threads.acquireThreadLease("thread_lease_remote", {
        ownerHostname: "remote-host.example.invalid",
      });
      assert.throws(
        () => threads.acquireThreadLease("thread_lease_remote", {
          isProcessAlive: () => false,
        }),
        /already active.*remote-host/iu,
      );
      threads.releaseThreadLease(remote);
    } finally {
      storage.close();
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
        provider: "glm-coding-plan",
        model: "glm-5.3-flash",
        goal: "test recovery",
        messages: [{ role: "user", content: "hello" }, assistantMessage],
      });
      state.mode = "code";
      state.thinkingEffort = "high";
      state.workingSummary = "verified summary";
      state.compactedMessageCount = 2;
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
      assert.equal(recovered.provider, "glm-coding-plan");
      assert.equal(recovered.model, "glm-5.3-flash");
      assert.equal(recovered.mode, "code");
      assert.equal(recovered.thinkingEffort, "high");
      assert.equal(recovered.workingSummary, "verified summary");
      assert.equal(recovered.compactedMessageCount, 2);
      const legacyCheckpoint = serializeSessionState(recovered) as unknown as Record<string, unknown>;
      delete legacyCheckpoint.compactedMessageCount;
      delete legacyCheckpoint.thinkingEffort;
      const migratedLegacyCheckpoint = deserializeSessionState(legacyCheckpoint);
      assert.equal(migratedLegacyCheckpoint.compactedMessageCount, 0);
      assert.equal(migratedLegacyCheckpoint.workingSummary, "");
      assert.equal(migratedLegacyCheckpoint.thinkingEffort, "medium");
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
      const rebuiltLease = threads.acquireThreadLease("thread_restore");
      threads.releaseThreadLease(rebuiltLease);
      assert.equal(threads.list()[0]?.threadId, "thread_restore");
      assert.equal(threads.rebuildProjection("thread_restore").workingSummary, "verified summary");
      assert.equal(threads.rebuildProjection("thread_restore").compactedMessageCount, 2);
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
        type: "context.compacted",
        turnId,
        phase: "completed",
        payload: {
          summary: "Objective: finish after restoring this compacted thread.",
          compactedMessageCount: 3,
          summaryChars: 55,
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
      assert.equal(
        recovered.workingSummary,
        "Objective: finish after restoring this compacted thread.",
      );
      assert.equal(recovered.compactedMessageCount, 3);
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

  it("repairs missing tool results before closing an interrupted turn", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_interrupted_tools",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
      const turnId = "turn_interrupted_tools";
      threads.appendEvent("thread_interrupted_tools", {
        type: "message.user",
        turnId,
        payload: {
          content: "inspect files",
          message: { role: "user", content: "inspect files" },
        },
      });
      threads.appendEvent("thread_interrupted_tools", {
        type: "message.assistant",
        turnId,
        payload: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_completed",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
            {
              id: "call_missing",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      });
      threads.appendEvent("thread_interrupted_tools", {
        type: "tool.result",
        turnId,
        payload: {
          callId: "call_completed",
          tool: "read_file",
          message: {
            role: "tool",
            tool_call_id: "call_completed",
            name: "read_file",
            content: '{"ok":true}',
          },
        },
      });

      const state = threads.recover("thread_interrupted_tools");
      assert.equal(repairInterruptedTurn(threads, state), true);
      assert.equal(state.activeTurnId, undefined);
      assert.equal(state.messages.at(-2)?.role, "tool");
      const repairedTool = state.messages.at(-2);
      if (repairedTool?.role === "tool") {
        assert.equal(repairedTool.tool_call_id, "call_missing");
        assert.match(repairedTool.content, /interrupted/u);
      }
      assert.equal(state.messages.at(-1)?.role, "assistant");

      const recovered = threads.recover("thread_interrupted_tools");
      assert.equal(recovered.activeTurnId, undefined);
      assert.equal(
        recovered.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "call_missing",
        ),
        true,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not journal or timestamp an empty checkpoint delta", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_empty_checkpoint",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      const journal = threads.journal(state.threadId);
      assert.strictEqual(journal, threads.journal(state.threadId));
      const eventCount = journal.read().length;
      const stateUpdatedAt = state.updatedAt;
      const projectedUpdatedAt = threads.list()[0]?.updatedAt;

      threads.save(state);

      assert.equal(journal.read().length, eventCount);
      assert.equal(state.updatedAt, stateUpdatedAt);
      assert.equal(threads.list()[0]?.updatedAt, projectedUpdatedAt);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("updates a cumulative summary at the same compaction boundary", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_same_boundary_summary",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
      });
      state.workingSummary = "Initial cumulative summary.";
      state.compactedMessageCount = 2;
      threads.save(state);
      state.workingSummary = "Replacement cumulative summary at the same boundary.";
      threads.save(state);

      const checkpoints = threads.journal(state.threadId).read().filter(
        (event) => event.type === "thread_checkpoint_delta",
      );
      assert.equal(checkpoints.length, 2);
      assert.deepEqual(
        (checkpoints[1]?.payload as { compaction?: unknown }).compaction,
        {
          workingSummary: "Replacement cumulative summary at the same boundary.",
          compactedMessageCount: 2,
        },
      );
      assert.equal(
        threads.recover(state.threadId).workingSummary,
        "Replacement cumulative summary at the same boundary.",
      );

      threads.save(state);
      assert.equal(threads.journal(state.threadId).read().length, 3);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a strict stale message prefix replaces mutable checkpoint state", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const current = threads.create({
        threadId: "thread_stale_replacement",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "base request" }],
      });
      const stale = deserializeSessionState(serializeSessionState(current));
      threads.appendEvent(current.threadId, {
        type: "message.assistant",
        turnId: "turn_stale_replacement",
        phase: "completed",
        payload: { role: "assistant", content: "newer durable response" },
      });
      const eventCount = threads.journal(current.threadId).read().length;
      stale.mode = "plan";
      stale.filesRead.set("stale.ts", {
        path: "stale.ts",
        hash: "stale-hash",
        readAt: "2026-09-06T13:00:00.000Z",
      });

      assert.throws(
        () => threads.save(stale),
        /Stale thread checkpoint cannot replace newer checkpoint-owned state/u,
      );
      assert.equal(threads.journal(current.threadId).read().length, eventCount);
      const recovered = threads.recover(current.threadId);
      assert.equal(recovered.mode, "code");
      assert.equal(recovered.filesRead.size, 0);
      assert.equal(recovered.messages.at(-1)?.content, "newer durable response");
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("writes bounded incremental checkpoints without repeating durable history", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const historicalMarker = `DO_NOT_REPEAT_FULL_HISTORY_${"x".repeat(96_000)}`;
      const state = threads.create({
        threadId: "thread_incremental_checkpoint",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen3.7-max",
        messages: [{ role: "user", content: historicalMarker }],
      });
      state.mode = "code";
      state.messages.push({ role: "assistant", content: "first incremental message" });
      state.filesRead.set("src/first.ts", {
        path: "src/first.ts",
        hash: "hash-first",
        readAt: "2026-09-06T10:00:00.000Z",
      });
      state.changes.push({
        path: "src/first.ts",
        operation: "create",
        afterHash: "hash-first",
        source: "file_tool",
        status: "applied",
        timestamp: "2026-09-06T10:00:01.000Z",
      });
      state.commands.push({
        id: "command_incremental_first",
        program: "node",
        args: ["--version"],
        cwd: state.workspaceRoot,
        status: "exited",
        exitCode: 0,
        durationMs: 10,
        timestamp: "2026-09-06T10:00:02.000Z",
        summary: "version checked",
      });
      state.workingSummary = "The original request is represented through message one.";
      state.compactedMessageCount = 1;
      threads.save(state);

      state.messages.push({ role: "user", content: "second incremental message" });
      state.filesRead.delete("src/first.ts");
      state.filesRead.set("src/second.ts", {
        path: "src/second.ts",
        hash: "hash-second",
        readAt: "2026-09-06T10:00:03.000Z",
      });
      state.changes.push({
        path: "src/second.ts",
        operation: "update",
        beforeHash: "before-second",
        afterHash: "hash-second",
        source: "file_tool",
        status: "verified",
        timestamp: "2026-09-06T10:00:04.000Z",
      });
      threads.save(state);

      const checkpoints = threads.journal(state.threadId).read().filter(
        (event) => event.type === "thread_checkpoint_delta",
      );
      assert.equal(checkpoints.length, 2);
      assert.equal(
        threads.journal(state.threadId).read().some(
          (event) => event.type === "thread_checkpoint",
        ),
        false,
      );
      const firstPayload = checkpoints[0]?.payload as Record<string, unknown>;
      const secondPayload = checkpoints[1]?.payload as Record<string, unknown>;
      assert.equal("state" in firstPayload, false);
      assert.equal(JSON.stringify(firstPayload).includes(historicalMarker), false);
      assert.equal(JSON.stringify(secondPayload).includes(historicalMarker), false);
      assert.deepEqual(
        (firstPayload.messagesAppended as Array<{ content: string }>).map(
          (message) => message.content,
        ),
        ["first incremental message"],
      );
      assert.deepEqual(
        (secondPayload.messagesAppended as Array<{ content: string }>).map(
          (message) => message.content,
        ),
        ["second incremental message"],
      );
      assert.equal("commandsAppended" in secondPayload, false);
      assert.deepEqual(
        (secondPayload.changesAppended as Array<{ path: string }>).map(
          (change) => change.path,
        ),
        ["src/second.ts"],
      );
      assert.deepEqual(secondPayload.filesReadRemoved, ["src/first.ts"]);
      assert.deepEqual(
        (secondPayload.filesReadUpserted as Array<[string, unknown]>).map(
          ([filePath]) => filePath,
        ),
        ["src/second.ts"],
      );

      const recovered = threads.recover(state.threadId);
      assert.deepEqual(recovered.messages, state.messages);
      assert.deepEqual([...recovered.filesRead.entries()], [...state.filesRead.entries()]);
      assert.deepEqual(recovered.changes, state.changes);
      assert.deepEqual(recovered.commands, state.commands);
      assert.equal(recovered.mode, "code");
      assert.equal(recovered.compactedMessageCount, 1);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("replays a legacy full checkpoint, an incremental checkpoint, and later events", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const initial = threads.create({
        threadId: "thread_mixed_checkpoints",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "created history" }],
      });
      initial.messages.push({ role: "assistant", content: "legacy checkpoint history" });
      initial.filesRead.set("legacy.ts", {
        path: "legacy.ts",
        hash: "legacy-hash",
        readAt: "2026-09-06T11:00:00.000Z",
      });
      threads.journal(initial.threadId).append({
        type: "thread_checkpoint",
        payload: { state: serializeSessionState(initial) },
      });

      const incremental = threads.recover(initial.threadId);
      incremental.mode = "code";
      incremental.messages.push({ role: "user", content: "delta history" });
      incremental.filesRead.delete("legacy.ts");
      incremental.changes.push({
        path: "delta.ts",
        operation: "create",
        afterHash: "delta-hash",
        source: "file_tool",
        status: "applied",
        timestamp: "2026-09-06T11:00:01.000Z",
      });
      threads.save(incremental);
      threads.appendEvent(initial.threadId, {
        type: "message.assistant",
        turnId: "turn_after_delta",
        phase: "completed",
        payload: { role: "assistant", content: "later journal event" },
      });

      const events = threads.journal(initial.threadId).read();
      assert.deepEqual(events.map((event) => event.type), [
        "thread_created",
        "thread_checkpoint",
        "thread_checkpoint_delta",
        "message.assistant",
      ]);
      assert.equal(
        (events[2]?.payload as { baseSequence?: number }).baseSequence,
        events[1]?.sequence,
      );
      const recovered = threads.recover(initial.threadId);
      assert.deepEqual(
        recovered.messages.map((message) => message.content),
        [
          "created history",
          "legacy checkpoint history",
          "delta history",
          "later journal event",
        ],
      );
      assert.equal(recovered.mode, "code");
      assert.equal(recovered.filesRead.size, 0);
      assert.equal(recovered.changes[0]?.path, "delta.ts");
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized or sequence-detached incremental checkpoints", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const oversized = threads.create({
        threadId: "thread_oversized_delta",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      oversized.messages.push({
        role: "user",
        content: "x".repeat(MAX_SERIALIZED_THREAD_CHECKPOINT_DELTA_BYTES),
      });
      assert.throws(
        () => threads.save(oversized),
        /checkpoint delta exceeds/u,
      );
      assert.equal(threads.journal(oversized.threadId).read().length, 1);

      const detached = threads.create({
        threadId: "thread_detached_delta",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      threads.journal(detached.threadId).append({
        type: "thread_checkpoint_delta",
        payload: { formatVersion: 1, baseSequence: 2 },
      });
      assert.throws(
        () => threads.recover(detached.threadId),
        /base sequence 2; expected 1/u,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
