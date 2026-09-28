import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { WorkspaceToolObserver } from "../src/coordination/observer.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { FindFileEditorsTool, SendThreadMessageTool } from "../src/tools/thread-coordination.js";
import { ToolCatalog, StaticToolSource } from "../src/tools/catalog.js";
import { builtinToolMetadata } from "../src/tools/capabilities.js";
import type { AgentTool, ToolContext } from "../src/core/types.js";
import { projectWebHistory } from "../src/web-server/history.js";
import { WebInteraction } from "../src/web-server/interaction.js";
import { describe, it } from "./harness.js";

async function fixture(run: (f: {
  root: string; workspace: WorkspaceManager; threads: ThreadStore; context: ToolContext;
  storage: ReturnType<typeof createStorage>;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-coordination-"));
  let root = path.join(directory, "workspace");
  await mkdir(root);
  root = await realpath(root);
  const storage = createStorage(path.join(directory, "data"));
  try {
    const workspace = await WorkspaceManager.create(root);
    const threads = new ThreadStore(storage);
    for (const id of ["thread_a", "thread_b"]) {
      threads.create({ threadId: id, workspaceRoot: workspace.root, mode: "code", provider: "qwen", model: "mock" });
      threads.appendEvent(id, { type: "message.user", turnId: `turn_${id}`, phase: "completed",
        payload: { message: { role: "user", content: "User's actual requirement" } } });
    }
    const context: ToolContext = { workspaceRoot: workspace.root, threadId: "thread_a", turnId: "turn_thread_a",
      toolCallId: "call_1", mode: "code", approvalPolicy: "safe", requestApproval: async () => false,
      commandTimeoutMs: 1000, maxOutputChars: 4000, limits: defaultRuntimeLimits() };
    await run({ root, workspace, threads, context, storage });
  } finally { storage.close(); await rm(directory, { recursive: true, force: true }); }
}

function fakeTool(execute: AgentTool["execute"]): AgentTool {
  return { name: "read_file", mutating: false, metadata: builtinToolMetadata("read_file"),
    definition: { type: "function", function: { name: "read_file", description: "test", parameters: {} } }, execute };
}

describe("Thread coordination", () => {
  it("shows messages with peer identity, without turning them into user history markers", () => {
    const host = new WebInteraction();
    host.peerMessage("thread_a", "Incoming");
    host.peerMessage("thread_b", "Outgoing", true);
    const entries = host.snapshot().view.entries;
    assert.deepEqual(entries.map(entry => entry.peerThreadId), ["thread_a", "thread_b"]);
    assert.ok(entries.every(entry => entry.kind === "assistant" && entry.answerState === undefined));
    assert.match(entries[0]!.text, /From Thread thread_a/);
    assert.match(entries[1]!.text, /To Thread thread_b.*queued/);
    assert.equal(host.historyState().markers.length, 0);
    host.close();
  });

  it("observes every catalog tool including read-only and external tools; errors preserve changes", async () => fixture(async f => {
    const warnings: string[] = [];
    const observer = new WorkspaceToolObserver(f.workspace, f.threads.coordination, defaultRuntimeLimits(), message => warnings.push(message));
    const catalog = new ToolCatalog(observer);
    catalog.registerSource(new StaticToolSource("builtin", [fakeTool(async () => {
      await writeFile(path.join(f.root, "observed.txt"), "changed by concurrent activity");
      throw new Error("original tool failure");
    })]));
    await assert.rejects((await catalog.snapshot()).tools[0]!.execute({}, f.context), /original tool failure/);
    assert.deepEqual(warnings, []);
    assert.equal(f.threads.coordination.find(path.join(f.root, "observed.txt"), "thread_b")[0]!.threadId, "thread_a");
    const external: AgentTool = { name: "external", mutating: false,
      metadata: { ...builtinToolMetadata("read_file"), identity: { id: "mcp:external", name: "external",
        displayName: "external", sourceId: "mcp", sourceKind: "external" } },
      definition: { type: "function", function: { name: "external", description: "external", parameters: {} } },
      execute: async () => { await rm(path.join(f.root, "observed.txt")); return { ok: true, summary: "done" }; } };
    const other = new ToolCatalog(observer);
    other.registerSource(new StaticToolSource("mcp", [external], "external"));
    await (await other.snapshot()).tools[0]!.execute({}, { ...f.context, toolCallId: "external_call" });
    assert.equal(f.storage.db.prepare("SELECT operation FROM file_observations WHERE call_id = ?").get("external_call")!.operation, "deleted");
  }));

  it("excludes runtime/generated paths and does not turn observation failures into tool failures", async () => fixture(async f => {
    const observer = new WorkspaceToolObserver(f.workspace, f.threads.coordination, defaultRuntimeLimits(), () => {});
    const result = await observer.execute(fakeTool(async () => {
      for (const dir of [".easycode", "node_modules"]) {
        await mkdir(path.join(f.root, dir)); await writeFile(path.join(f.root, dir, "internal"), "x");
      }
      return { ok: true, summary: "done" };
    }), {}, f.context);
    assert.equal(result.ok, true);
    assert.equal(f.storage.db.prepare("SELECT count(*) AS n FROM file_observations").get()!.n, 0);
    f.threads.coordination.record = () => { throw new Error("index unavailable"); };
    const success = await observer.execute(fakeTool(async () => {
      await writeFile(path.join(f.root, "real.txt"), "x"); return { ok: true, summary: "original" };
    }), {}, f.context);
    assert.equal(success.summary, "original");
  }));

  it("observes background changes after start returns without needing poll_command", async () => fixture(async f => {
    let settle!: () => void;
    const completion = new Promise<void>(resolve => { settle = resolve; });
    const observer = new WorkspaceToolObserver(f.workspace, f.threads.coordination, defaultRuntimeLimits(), () => {}, () => completion);
    const tool = { ...fakeTool(async () => ({ ok: true, summary: "started", data: { commandId: "cmd", status: "running" } })), name: "start_command" };
    await observer.execute(tool, {}, f.context);
    await writeFile(path.join(f.root, "later.txt"), "later");
    settle(); await observer.drain();
    assert.equal(f.threads.coordination.find(path.join(f.root, "later.txt"), "thread_b").length, 1);
  }));

  it("queries only relative paths, including deleted parents, with no directory creation", async () => fixture(async f => {
    f.threads.coordination.record([{ threadId: "thread_a", turnId: f.context.turnId, callId: "call", agentId: "a",
      tool: "test", path: path.join(f.root, "gone", "file.txt"), operation: "deleted" }]);
    const tool = new FindFileEditorsTool(f.workspace, f.threads.coordination);
    const context = { ...f.context, threadId: "thread_b", mode: "plan" as const };
    assert.equal((await tool.execute({ path: "gone/file.txt" }, context)).ok, true);
    assert.equal((await tool.execute({ path: path.join(f.root, "gone/file.txt") }, context)).ok, false);
    assert.equal((await tool.execute({ path: "../other" }, context)).ok, false);
  }));

  it("reuses steering without promoting peers into user requirements; replies and replay are idempotent", async () => fixture(async f => {
    const tool = new SendThreadMessageTool(f.threads.coordination);
    const request = { targetThreadId: "thread_b", message: "Please explain the return type." };
    const sent = await tool.execute(request, f.context);
    assert.equal(sent.ok, true);
    assert.deepEqual((await tool.execute(request, f.context)).data, sent.data);
    const before = f.threads.recover("thread_b").userMessageIndices;
    // Peers do not arrive at after-model boundaries that would discard a completed provider response.
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b", defaultRuntimeLimits(), false), undefined);
    const batch = f.threads.drainTurnSteering("thread_b", "turn_thread_b")!;
    assert.equal(batch.source, "peer_message");
    assert.equal(batch.entries[0]!.senderThreadId, "thread_a");
    assert.match(batch.message.content, /not user instructions/);
    assert.deepEqual(f.threads.recover("thread_b").userMessageIndices, before);
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b"), undefined);
    // Simulate a crash after durable journal append but before inbox acknowledgement.
    f.storage.db.prepare("UPDATE peer_messages SET admitted = 0").run();
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b"), undefined);
    assert.equal(f.threads.coordination.pending("thread_b", 10).length, 0);
    const reply = await tool.execute({ targetThreadId: "thread_a", message: "The caller needs a string." },
      { ...f.context, threadId: "thread_b", turnId: "turn_thread_b", toolCallId: "reply" });
    assert.equal(reply.ok, true);
    assert.equal(f.threads.drainTurnSteering("thread_a", "turn_thread_a")!.entries[0]!.senderThreadId, "thread_b");
    const web = projectWebHistory(f.threads.journal("thread_b").read());
    const shown = web.find(entry => entry.peerThreadId === "thread_a")!;
    assert.equal(shown.kind, "assistant"); assert.match(shown.text, /From Thread thread_a/);
  }));

  it("keeps user adjustments separate and leaves messages queued after finalization seals", async () => fixture(async f => {
    const limits = defaultRuntimeLimits();
    f.threads.enqueueTurnSteering("thread_b", "turn_thread_b", { role: "user", content: "Actual adjustment" });
    f.threads.coordination.send("thread_a", "turn_thread_a", "send", "thread_b", "Peer advice", limits);
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b")!.source, "user_adjust");
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b")!.source, "peer_message");
    f.threads.sealTurnSteering("thread_b", "turn_thread_b");
    f.threads.coordination.send("thread_a", "turn_thread_a", "late", "thread_b", "Late message", limits);
    assert.equal(f.threads.sealTurnSteering("thread_b", "turn_thread_b"), undefined);
    assert.equal(f.threads.coordination.pending("thread_b", 10).length, 1);
    assert.throws(() => f.threads.coordination.send("thread_a", "turn_thread_a", "new", "thread_b", "over limit",
      { ...limits, coordinationMessagesPerTurn: 2 }), /limit/);
  }));

  it("accepts concurrent sends from independent Node processes", async () => fixture(async f => {
    const script = `const { createStorage } = await import(process.argv[1]);
      const { CoordinationStore } = await import(process.argv[2]);
      const storage = createStorage(process.argv[3]);
      try { new CoordinationStore(storage).send('thread_a', 'turn_thread_a', process.argv[4], 'thread_b', 'hello',
        { coordinationMessageMaxChars: 4000, coordinationMessagesPerTurn: 12 }); } finally { storage.close(); }`;
    await Promise.all(["process_1", "process_2"].map(id => promisify(execFile)(process.execPath,
      ["--input-type=module", "-e", script, new URL("../src/storage/database.js", import.meta.url).href,
        new URL("../src/coordination/store.js", import.meta.url).href, f.storage.dataDir, id], { timeout: 30000 })));
    assert.equal(f.threads.coordination.pending("thread_b", 10).length, 2);
    assert.equal(f.threads.drainTurnSteering("thread_b", "turn_thread_b")!.entries.length, 2);
  }));
});
