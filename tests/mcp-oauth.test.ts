import assert from "node:assert/strict";
import { createServer } from "node:http";
import { authorizeMcpServer, type McpOauthCredentialStore, type SavedCredentials } from "../src/mcp/oauth.js";
import { describe, it } from "./harness.js";

describe("MCP OAuth", () => {
  it("discovers, registers, checks callback state, and stores tokens outside the config", async () => {
    let origin = "";
    let saved: SavedCredentials = {};
    let announced = "";
    let tokenRequest = "";
    let registrations = 0;
    const credentials: McpOauthCredentialStore = {
      async read() { return structuredClone(saved); },
      async update(change) { const next = structuredClone(saved); change(next); saved = next; },
      async clear() { saved = {}; },
      async hasTokens() { return Boolean(saved.tokens?.access_token); },
    };
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", origin).pathname;
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      } else if (path === "/.well-known/oauth-authorization-server") {
        send(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      } else if (path === "/register") {
        registrations += 1;
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        send(201, { ...JSON.parse(body) as Record<string, unknown>, client_id: "easy-code-test" });
      } else if (path === "/token") {
        for await (const chunk of request) tokenRequest += chunk.toString();
        send(200, { access_token: "test-access", token_type: "Bearer", refresh_token: "test-refresh" });
      } else send(404, { error: "not_found" });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    try {
      await authorizeMcpServer("test", `${origin}/mcp`, url => {
        announced = url;
        const authorization = new URL(url);
        assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "test-code");
        void fetch(callback).catch(() => undefined);
      }, credentials);
      assert.match(announced, /\/authorize\?/u);
      assert.match(tokenRequest, /code=test-code/u);
      assert.equal(saved.tokens?.access_token, "test-access");
      assert.equal(saved.client?.client_id, "easy-code-test");
      const controller = new AbortController();
      await assert.rejects(authorizeMcpServer("test", `${origin}/mcp`, () => {
        const cancellation = new Error("Canceled by terminal");
        cancellation.name = "AbortError";
        controller.abort(cancellation);
      }, credentials, controller.signal), /Canceled by terminal/u);
      assert.equal(saved.tokens?.access_token, "test-access", "canceling reauthentication preserves earlier tokens");
      assert.ok(registrations >= 2, "a new loopback callback requires new client registration");
      await credentials.clear();
      await assert.rejects(authorizeMcpServer("test", `${origin}/mcp`, url => {
        const authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", "wrong-state");
        callback.searchParams.set("code", "test-code");
        void fetch(callback).catch(() => undefined);
      }, credentials), /state did not match/u);
      assert.equal(saved.tokens, undefined);
      await assert.rejects(authorizeMcpServer("test", `${origin}/mcp`, url => {
        const authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("error", "access_denied");
        void fetch(callback).catch(() => undefined);
      }, credentials), /access_denied/u);
      assert.equal(saved.tokens, undefined);
      await assert.rejects(authorizeMcpServer("test", `${origin}/mcp`, () => undefined,
        credentials, undefined, 250), /timed out/u);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
