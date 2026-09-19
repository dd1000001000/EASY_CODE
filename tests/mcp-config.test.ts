import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { McpConfigStore } from "../src/mcp/config.js";
import {
  DisableMcpServerTool,
  ListMcpServersTool,
  RemoveMcpServerTool,
  SaveLocalMcpServerTool,
  SaveRemoteMcpServerTool,
} from "../src/tools/mcp-config-tools.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

async function withStore(run: (store: McpConfigStore, root: string) => Promise<void>): Promise<void> {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(repoRoot, ".tmp-mcp-config-"));
  try { await run(new McpConfigStore(path.join(root, "user", "mcp.toml")), root); }
  finally {
    assert.equal(path.dirname(root), repoRoot);
    assert.match(path.basename(root), /^\.tmp-mcp-config-/u);
    await rm(root, { recursive: true, force: true });
  }
}

describe("user MCP configuration", () => {
  it("stores disabled servers atomically and never stores raw environment secrets", async () => {
    await withStore(async (store) => {
      await store.upsert("reader", {
        command: "node", args: ["server.js"], cwd: ".",
        env: { TOKEN: "env:MCP_READER_TOKEN" },
      });
      const saved = await store.read();
      assert.equal(saved.version, 2);
      assert.equal(saved.servers.reader?.transport, "stdio");
      assert.equal(saved.servers.reader?.enabled, false);
      assert.deepEqual(saved.servers.reader?.env, { TOKEN: "env:MCP_READER_TOKEN" });
      const file = await readFile(store.filePath, "utf8");
      assert.match(file, /TOKEN = "env:MCP_READER_TOKEN"/u);
      assert.doesNotMatch(file, /secret-value/u);
      await store.setEnabled("reader", true);
      assert.equal((await store.read()).servers.reader?.enabled, true);
      await store.upsert("reader", { command: "node", args: ["updated.js"], cwd: ".", env: {} });
      assert.equal((await store.read()).servers.reader?.enabled, false);
      await store.remove("reader");
      assert.deepEqual((await store.read()).servers, {});
    });
  });

  it("rejects invalid credential references without changing an existing file", async () => {
    await withStore(async (store) => {
      await store.upsert("reader", { command: "node", args: [], cwd: ".", env: {} });
      const before = await readFile(store.filePath, "utf8");
      await assert.rejects(store.upsert("reader", {
        command: "node", args: [], cwd: ".", env: { TOKEN: "raw-secret" },
      }));
      assert.equal(await readFile(store.filePath, "utf8"), before);
    });
  });

  it("lets the agent edit config but never enable or start a server", async () => {
    await withStore(async (store) => {
      const root = process.cwd();
      const workspace = new WorkspaceManager(root);
      const listTool = new ListMcpServersTool(workspace, store);
      const saveTool = new SaveLocalMcpServerTool(workspace, store);
      const disableTool = new DisableMcpServerTool(workspace, store);
      const removeTool = new RemoveMcpServerTool(workspace, store);
      const context = { workspaceRoot: root, mode: "code", agentRole: "main_agent" } as ToolContext;
      const saved = await saveTool.execute({ id: "reader", command: "node",
        args: ["server.js"], env: [{ name: "TOKEN", source: "env:MCP_READER_TOKEN" }] }, context);
      assert.equal(saved.ok, true);
      assert.equal((await store.read()).servers.reader?.enabled, false);
      const list = await listTool.execute({}, context);
      assert.equal(list.ok, true);
      assert.deepEqual((list.data as { servers: { id: string }[] }).servers.map(server => server.id), ["reader"]);
      const unsupported = await saveTool.execute({ id: "reader", command: "node", enabled: true }, context);
      assert.equal(unsupported.ok, false);
      const child = await removeTool.execute({ id: "reader" },
        { ...context, agentRole: "subagent" });
      assert.equal(child.ok, false);
      assert.ok((await store.read()).servers.reader);
      await store.setEnabled("reader", true);
      assert.equal((await disableTool.execute({ id: "reader" }, context)).ok, true);
      assert.equal((await store.read()).servers.reader?.enabled, false);
      assert.equal((await removeTool.execute({ id: "reader" }, context)).ok, true);
      assert.equal((await store.read()).servers.reader, undefined);
    });
  });

  it("keeps invalid changes from disconnecting and disconnects only after a successful write", async () => {
    await withStore(async store => {
      const root = process.cwd();
      const workspace = new WorkspaceManager(root);
      const disconnected: string[] = [];
      const saveLocal = new SaveLocalMcpServerTool(workspace, store, async id => {
        assert.equal((await store.read()).servers[id]?.enabled, false);
        disconnected.push(id);
      });
      const saveRemote = new SaveRemoteMcpServerTool(workspace, store, async id => {
        assert.equal((await store.read()).servers[id]?.enabled, false);
        disconnected.push(id);
      });
      const context = { workspaceRoot: root, mode: "code", agentRole: "main_agent" } as ToolContext;
      assert.equal((await saveLocal.execute({ id: "reader", command: "node",
        env: [{ name: "TOKEN", source: "env:MCP_TOKEN" },
          { name: "TOKEN", source: "env:OTHER_TOKEN" }] }, context)).ok, false);
      assert.deepEqual(disconnected, []);
      assert.equal((await saveRemote.execute({ id: "remote", transport: "http",
        url: "https://mcp.example.com/mcp?token=secret" }, context)).ok, false);
      assert.deepEqual(disconnected, []);
      assert.equal((await saveRemote.execute({ id: "remote", transport: "http",
        url: "https://mcp.example.com/mcp", auth: "oauth" }, context)).ok, true);
      assert.deepEqual(disconnected, ["remote"]);
      assert.equal((await saveLocal.execute({ id: "reader", command: "node" }, context)).ok, true);
      assert.deepEqual(disconnected, ["remote", "reader"]);
    });
  });

  it("configures remote HTTP with a bearer reference and rejects credential-bearing URLs", async () => {
    await withStore(async store => {
      await store.upsert("remote", { transport: "http", url: "https://mcp.example.com/mcp",
        auth: "bearer", bearerTokenEnvVar: "MCP_TOKEN" });
      const saved = (await store.read()).servers.remote;
      assert.equal(saved?.transport, "http");
      assert.equal(saved?.enabled, false);
      const source = await readFile(store.filePath, "utf8");
      assert.match(source, /bearerTokenEnvVar = "MCP_TOKEN"/u);
      await assert.rejects(store.upsert("bad", { transport: "http",
        url: "https://mcp.example.com/mcp?token=secret", auth: "none" }));
      await assert.rejects(store.upsert("bad", { transport: "http",
        url: "http://mcp.example.com/mcp", auth: "none" }));
      assert.deepEqual(Object.keys((await store.read()).servers), ["remote"]);
    });
  });

  it("reads version-one stdio configuration and rewrites it as version two", async () => {
    await withStore(async store => {
      await mkdir(path.dirname(store.filePath), { recursive: true });
      await writeFile(store.filePath, 'version = 1\n[servers.old]\ncommand = "node"\nargs = []\ncwd = "."\nenabled = false\n');
      assert.equal((await store.read()).servers.old?.transport, "stdio");
      await store.setEnabled("old", true);
      assert.match(await readFile(store.filePath, "utf8"), /version = 2/u);
    });
  });
});
