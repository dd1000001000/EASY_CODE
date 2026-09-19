import assert from "node:assert/strict";
import { EasyCodeApp } from "../src/app.js";
import type { McpServerConfig, RemoteMcpServerConfig } from "../src/mcp/config.js";
import { describe, it } from "./harness.js";

type McpMenuApp = {
  showMcpServers(): Promise<void>;
  connectAuthenticatedMcpServer(id: string, server: RemoteMcpServerConfig): Promise<number>;
};

function menuApp(server: McpServerConfig, answers: string[]) {
  const app = Object.create(EasyCodeApp.prototype) as McpMenuApp & Record<string, unknown>;
  const prompts: string[] = [];
  const messages: string[] = [];
  const enabled: Array<[string, boolean]> = [];
  let reads = 0;
  let connections = 0;
  app.config = { dataDir: "unused-test-data" };
  app.mcpConfigStore = {
    filePath: "unused-test-mcp.toml",
    read: async () => { reads += 1; return { servers: { sample: server } }; },
    setEnabled: async (id: string, value: boolean) => { enabled.push([id, value]); },
  };
  app.mcpConnections = {
    status: () => ({ connected: false, toolCount: 0 }),
    connect: async () => { connections += 1; return 3; },
    disconnect: async () => undefined,
  };
  app.terminal = {
    selectChoice: async (title: string) => {
      prompts.push(title);
      const next = answers.shift();
      if (!next) throw new Error(`Unexpected MCP menu prompt: ${title}`);
      return next;
    },
    write: (value: string) => { messages.push(value); },
    success: (value: string) => { messages.push(value); },
    warning: (value: string) => { messages.push(value); },
    info: (value: string) => { messages.push(value); },
  };
  return { app, prompts, messages, enabled, get reads() { return reads; },
    get connections() { return connections; } };
}

describe("MCP app menu navigation", () => {
  const remote: RemoteMcpServerConfig = {
    transport: "http", url: "https://mcp.example.com/mcp", auth: "none", enabled: false,
  };

  it("returns to the main request after showing server details", async () => {
    const fixture = menuApp(remote, ["sample", "details"]);
    await fixture.app.showMcpServers();
    assert.equal(fixture.reads, 1);
    assert.equal(fixture.prompts.length, 2);
    assert.match(fixture.messages.join("\n"), /mcp\.example\.com/u);
  });

  it("returns to the main request after connecting a remote server", async () => {
    const fixture = menuApp(remote, ["sample", "connect", "connect"]);
    await fixture.app.showMcpServers();
    assert.equal(fixture.reads, 1);
    assert.equal(fixture.prompts.length, 3);
    assert.equal(fixture.connections, 1);
    assert.deepEqual(fixture.enabled, [["sample", true]]);
  });

  it("explicit Back still returns to the server list", async () => {
    const fixture = menuApp(remote, ["sample", "back", "sample", "details"]);
    await fixture.app.showMcpServers();
    assert.equal(fixture.reads, 2);
    assert.equal(fixture.prompts.length, 4);
  });

  it("connects and enables a newly authenticated OAuth server", async () => {
    const oauth: RemoteMcpServerConfig = { ...remote, auth: "oauth" };
    const fixture = menuApp(oauth, []);
    assert.equal(await fixture.app.connectAuthenticatedMcpServer("sample", oauth), 3);
    assert.equal(fixture.connections, 1);
    assert.deepEqual(fixture.enabled, [["sample", true]]);
  });
});
