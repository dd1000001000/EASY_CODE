"use strict";

const { createInterface } = require("node:readline");

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: request.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "easy-code-mcp-smoke", version: "1.0.0" },
    };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo input text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: String(request.params?.arguments?.text ?? "") }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32601, message: "Method not found" } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
