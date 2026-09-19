import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "node:http";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpCatalogTools, createMcpTool, McpConnections } from "../src/mcp/source.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { toolRequiresApproval } from "../src/tools/capabilities.js";
import { toolResultForModel } from "../src/tools/errors.js";
import { StaticToolSource, ToolCatalog } from "../src/tools/catalog.js";
import { describe, it } from "./harness.js";

describe("MCP tool adapter", () => {
  it("handshakes, lists, and calls a real stdio MCP server", async () => {
    const server = path.join(process.cwd(), "tests", "fixtures", "mcp-echo-server.cjs");
    const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: "pipe" });
    const client = new Client({ name: "easy-code-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(tool => tool.name), ["echo"]);
      const result = await createMcpTool("smoke", listed.tools[0]!, client).execute({ text: "MCP_OK" }, {} as never);
      assert.deepEqual(result.content, [{ type: "text", text: "MCP_OK" }]);
      assert.equal((result.data as { mcpContent: { text: string }[] }).mcpContent[0]?.text, "MCP_OK");
      const projected = JSON.parse(toolResultForModel({ ...result, evidenceId: "evidence_small" }, 64_000)) as {
        content: { text: string }[]; data: Record<string, unknown>;
      };
      assert.equal(projected.content[0]?.text, "MCP_OK");
      assert.equal(projected.data.completeResultInEvidence, true);
      assert.equal(projected.data.mcpContent, undefined, "the model should not receive a second full copy");
    } finally {
      await client.close();
    }
  });

  it("namespaces untrusted tools and requires approval even with read-only annotations", async () => {
    const calls: unknown[] = [];
    const client = { async callTool(input: unknown) {
      calls.push(input);
      return { content: [{ type: "text", text: "found" }], isError: false };
    } } as unknown as Pick<Client, "callTool">;
    const listed = { name: "search", description: "Search files", inputSchema: {
      type: "object", properties: { query: { type: "string" } }, required: ["query"],
    }, annotations: { readOnlyHint: true } } as Tool;
    const tool = createMcpTool("reader", listed, client);
    assert.match(tool.name, /^mcp_reader_search_[0-9a-f]{8}$/u);
    assert.equal(toolRequiresApproval(tool), true);
    const catalog = new ToolCatalog();
    catalog.registerSource(new StaticToolSource("mcp", [tool], "external"));
    const snapshot = await catalog.snapshot();
    assert.equal(snapshot.tools.length, 1);
    const result = await snapshot.tools[0]!.execute({ query: "needle" }, {} as never);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ name: "search", arguments: { query: "needle" } }]);
    assert.deepEqual(result.content, [{ type: "text", text: "found" }]);
  });

  it("rejects oversized schemas rather than exposing them to providers", () => {
    const huge = { name: "huge", inputSchema: { type: "object", description: "x".repeat(32_001) } } as Tool;
    assert.throws(() => createMcpTool("reader", huge, {} as Client), /unsupported input schema/u);
  });

  it("searches large catalogs and pages oversized schemas without losing callable tools", async () => {
    const calls: unknown[] = [];
    const client = { async callTool(input: unknown) {
      calls.push(input);
      return { content: [{ type: "text", text: "called" }] };
    } } as unknown as Pick<Client, "callTool">;
    const tools = Array.from({ length: 140 }, (_, index) => ({ name: `tool_${index}`,
      inputSchema: { type: "object", description: index === 139 ? "x".repeat(40_000) : "small" },
    })) as Tool[];
    const catalog = createMcpCatalogTools("large", tools, client);
    assert.equal(catalog.length, 3);
    const search = await catalog[0]!.execute({ query: "tool_139" }, {} as never);
    assert.equal((search.data as { tools: { name: string }[] }).tools[0]?.name, "tool_139");
    const first = await catalog[1]!.execute({ name: "tool_139" }, {} as never);
    const next = (first.data as { nextOffset: number | null }).nextOffset;
    assert.ok(next !== null);
    const second = await catalog[1]!.execute({ name: "tool_139", offset: next }, {} as never);
    assert.ok(String((second.data as { content: string }).content).length > 0);
    const called = await catalog[2]!.execute({ name: "tool_139", argumentsJson: '{"x":1}' }, {} as never);
    assert.equal(called.ok, true);
    assert.deepEqual(calls, [{ name: "tool_139", arguments: { x: 1 } }]);
    assert.equal(toolRequiresApproval(catalog[2]!), true);
  });

  it("keeps full oversized and non-text MCP results for evidence recall", async () => {
    const long = "A".repeat(60_000);
    const client = { async callTool() { return { content: [
      { type: "text", text: long }, { type: "image", data: "encoded-image", mimeType: "image/png" },
    ] }; } } as unknown as Pick<Client, "callTool">;
    const tool = createMcpTool("large", { name: "read", inputSchema: { type: "object" } } as Tool, client);
    const result = await tool.execute({}, {} as never);
    assert.ok(result.content?.some(item => item.type === "text" && item.text.includes("recall_context")));
    assert.equal(((result.data as { mcpContent: { text: string }[] }).mcpContent[0]!).text, long);
    assert.equal((result.data as { mcpContent: { type: string }[] }).mcpContent[1]?.type, "image");
    const projected = JSON.parse(toolResultForModel({ ...result, evidenceId: "evidence_test" }, 64_000)) as {
      evidenceId: string; content: { text: string }[]; data: { completeResultInEvidence: boolean };
    };
    assert.equal(projected.evidenceId, "evidence_test");
    assert.ok(projected.content[0]?.text.startsWith("AAAA"));
    assert.equal(projected.data.completeResultInEvidence, true);
  });

  it("connects to a remote server with more than 128 advertised tools", async () => {
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") { response.writeHead(202).end(); return; }
      if (request.method === "GET") { response.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "large", version: "1" } }
        : { tools: Array.from({ length: 130 }, (_, index) => ({ name: `tool_${index}`,
          inputSchema: { type: "object" } })) };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connections = new McpConnections(new WorkspaceManager(process.cwd()));
    try {
      assert.equal(await connections.connect("large", { transport: "http",
        url: `http://127.0.0.1:${address.port}/mcp`, auth: "none", enabled: false }), 130);
      assert.equal(connections.listTools().length, 3);
      assert.equal(connections.status("large").toolCount, 130);
      assert.deepEqual(connections.connectedServers(), [{ id: "large", toolCount: 130 }]);
    } finally {
      await connections.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("connects to a remote Streamable HTTP tool with an environment bearer token", async () => {
    const observed: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") { response.writeHead(202).end(); return; }
      if (request.method === "GET") { response.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      observed.push(request.headers.authorization ?? "");
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "remote-test", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : { content: [{ type: "text", text: message.params?.arguments?.text ?? "" }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const previous = process.env.EASY_CODE_MCP_TEST_TOKEN;
    process.env.EASY_CODE_MCP_TEST_TOKEN = "test-bearer";
    const connections = new McpConnections(new WorkspaceManager(process.cwd()));
    try {
      const count = await connections.connect("remote", { transport: "http",
        url: `http://127.0.0.1:${address.port}/mcp`, auth: "bearer",
        bearerTokenEnvVar: "EASY_CODE_MCP_TEST_TOKEN", enabled: false });
      assert.equal(count, 1);
      const result = await connections.listTools()[0]!.execute({ text: "REMOTE_OK" }, {} as never);
      assert.deepEqual(result.content, [{ type: "text", text: "REMOTE_OK" }]);
      assert.ok(observed.every(value => value === "Bearer test-bearer"));
    } finally {
      await connections.close();
      if (previous === undefined) delete process.env.EASY_CODE_MCP_TEST_TOKEN;
      else process.env.EASY_CODE_MCP_TEST_TOKEN = previous;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("connects to a legacy SSE server through the same catalog", async () => {
    let stream: import("node:http").ServerResponse | undefined;
    let origin = "";
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/sse") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.write(`event: endpoint\ndata: ${origin}/message\n\n`);
        stream = response;
        return;
      }
      if (request.method !== "POST" || request.url !== "/message") { response.writeHead(404).end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
      response.writeHead(202).end();
      if (message.id === undefined) return;
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sse-test", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : { content: [{ type: "text", text: message.params?.arguments?.text ?? "" }] };
      stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const connections = new McpConnections(new WorkspaceManager(process.cwd()));
    try {
      assert.equal(await connections.connect("legacy", { transport: "sse", url: `${origin}/sse`,
        auth: "none", enabled: false }), 1);
      const result = await connections.listTools()[0]!.execute({ text: "SSE_OK" }, {} as never);
      assert.deepEqual(result.content, [{ type: "text", text: "SSE_OK" }]);
    } finally {
      await connections.close();
      stream?.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
