import assert from "node:assert/strict";
import { mcpServerActions, type McpMenuState } from "../src/mcp/menu.js";
import type { McpServerConfig } from "../src/mcp/config.js";
import { describe, it } from "./harness.js";

const oauth: McpServerConfig = { transport: "http", url: "https://mcp.example.com/mcp",
  auth: "oauth", headers: {}, query: {}, enabled: false };
const base: McpMenuState = { connected: false, authenticated: false,
  authStoreReady: true, bearerReady: true, benchmark: false };
const ids = (server: McpServerConfig, state: McpMenuState) =>
  mcpServerActions(server, state).map(choice => choice.id);

describe("MCP action menu", () => {
  it("offers authorization before a first OAuth connection", () => {
    assert.deepEqual(ids(oauth, base), ["details", "authenticate", "remove", "back"]);
  });

  it("offers connect, reauthentication, and credential clearing only after authorization", () => {
    assert.deepEqual(ids(oauth, { ...base, authenticated: true }),
      ["details", "connect", "authenticate", "clear_auth", "remove", "back"]);
    assert.equal(mcpServerActions(oauth, { ...base, authenticated: true })[2]?.label, "Reauthenticate");
  });

  it("replaces connect and authorization with disconnect while connected", () => {
    assert.deepEqual(ids({ ...oauth, enabled: true }, { ...base, connected: true, authenticated: true }),
      ["details", "disconnect", "disable", "remove", "back"]);
    assert.equal(mcpServerActions({ ...oauth, enabled: true },
      { ...base, connected: true, authenticated: true })[1]?.detail, "Close the remote MCP connection");
  });

  it("does not offer unavailable bearer or credential-store actions", () => {
    const bearer: McpServerConfig = { transport: "http", url: "https://mcp.example.com/mcp",
      auth: "bearer", bearerTokenEnvVar: "MCP_TOKEN", headers: {}, query: {}, enabled: false };
    assert.deepEqual(ids(bearer, { ...base, bearerReady: false }), ["details", "remove", "back"]);
    assert.deepEqual(ids(oauth, { ...base, authStoreReady: false }), ["details", "remove", "back"]);
    assert.deepEqual(ids(oauth, { ...base, benchmark: true }), ["details", "remove", "back"]);
  });

  it("lets a disabled local server connect and hides Disable until enabled", () => {
    const local: McpServerConfig = { transport: "stdio", command: "node", args: [], cwd: ".",
      env: {}, enabled: false };
    assert.deepEqual(ids(local, base), ["details", "connect", "remove", "back"]);
    assert.deepEqual(ids({ ...local, enabled: true }, base),
      ["details", "connect", "disable", "remove", "back"]);
  });
});
