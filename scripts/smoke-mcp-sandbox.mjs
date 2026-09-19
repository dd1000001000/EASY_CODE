import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpConnections } from "../dist/mcp/source.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = new WorkspaceManager(root);
const connections = new McpConnections(workspace);
try {
  const count = await connections.connect("smoke", {
    transport: "stdio",
    command: process.execPath,
    args: [path.join(root, "tests", "fixtures", "mcp-echo-server.cjs")],
    cwd: ".",
    env: {},
    enabled: true,
  });
  assert.equal(count, 1);
  const tool = connections.listTools()[0];
  assert.ok(tool);
  const result = await tool.execute({ text: "MCP_OK" }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.content, [{ type: "text", text: "MCP_OK" }]);
  process.stdout.write("MCP sandbox stdio smoke passed.\n");
} finally {
  await connections.close();
}
