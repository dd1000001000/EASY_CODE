import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "node:http";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpTool, McpConnections } from "../src/mcp/source.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { toolRequiresApproval } from "../src/tools/capabilities.js";
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
