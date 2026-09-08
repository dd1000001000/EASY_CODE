import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectNetworkOperation } from "../src/command/network-policy.js";
import { CommandPolicy } from "../src/command/policy.js";
import { autoApproveNetwork } from "../src/command/network-approval.js";
import { createCommandNetworkGate, resolvePublicNetworkHost } from "../src/command/network-gate.js";
import { grantCommandApprovalPrefix, isCommandApprovalPrefixGranted, networkCommandApprovalPrefix } from "../src/command/approval.js";
import { CommandRuntime } from "../src/command/runtime.js";
import type { ResolvedCommand } from "../src/command/types.js";
import type { ApprovalRequest, CommandExecutionMode, ToolContext } from "../src/core/types.js";
import type { CommandExecutionBackend, SandboxExecutionRequest } from "../src/sandbox/types.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";
import { allowBrokeredNetworkHost } from "../src/command/network-destination.js";
import { createHttpProxyServer } from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import { resolveParentProxy } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";

function command(name: string, args: string[]): ResolvedCommand {
  return { program: name, executablePath: path.resolve(name), args, cwdAbsolute: process.cwd(), cwdRelative: ".",
    trustedExecutable: true, executableInsideWorkspace: false, environment: {}, environmentKeys: [] };
}

function proxyRequest(proxy: string, target: string, body = "", auth = true): Promise<{ status: number; text: string }> {
  const url = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: target, method: body ? "POST" : "GET",
      headers: auth ? { "Proxy-Authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}` } : {} }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.once("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("Proxy fixture timed out")));
    req.once("error", reject); req.end(body);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}

describe("network authorization", () => {
  it("applies the mode/effect matrix without treating downloads as reads", () => {
    for (const mode of ["manual", "auto_approve", "unrestricted"] as const) {
      for (const effect of ["read", "download", "upload", "unknown"] as const) {
        assert.equal(autoApproveNetwork(mode, effect), mode === "unrestricted" || mode === "auto_approve" && effect === "read");
      }
    }
  });

  it("uses trusted command recipes rather than model intent or executable names", () => {
    const read = command("curl", ["-q", "-fsSL", "https://example.invalid/doc"]);
    assert.equal(inspectNetworkOperation(read)?.effect, "read");
    read.args = ["-q", "-sS", "--fail", "https://example.invalid/doc"];
    assert.equal(inspectNetworkOperation(read)?.effect, "read");
    assert.equal(inspectNetworkOperation({ ...read, executableInsideWorkspace: true })?.effect, "unknown");
    for (const args of [["https://example.invalid"], ["-q", "-K", "config"], ["-q", "-H", "Secret: value", "https://example.invalid"]]) {
      assert.equal(inspectNetworkOperation(command("curl", args))?.effect, "unknown");
    }
    assert.equal(inspectNetworkOperation(command("curl", ["-q", "--output", "file", "https://example.invalid"]))?.effect, "download");
    assert.equal(inspectNetworkOperation(command("curl", ["-q", "--data", "body", "https://example.invalid"]))?.effect, "upload");
    assert.deepEqual(inspectNetworkOperation(command("git", ["fetch", "origin"]))?.prefixArgs, ["fetch"]);
    assert.equal(inspectNetworkOperation(command("git", ["push"]))?.effect, "upload");
    assert.equal(inspectNetworkOperation(command("python", ["-m", "pip", "install", "thing"]))?.effect, "download");
    assert.equal(inspectNetworkOperation(command("node", ["script.js"])), undefined);
    assert.equal(inspectNetworkOperation(command("curl", ["-q", "--version"])), undefined);
    assert.equal(new CommandPolicy().classify({ program: "curl", intent: "inspect" }, command("curl", ["-q", "--version"]), "plan", true).effect, "allow");
    assert.equal(inspectNetworkOperation(command("wget", ["--post-data=fixture", "https://example.invalid"]))?.effect, "upload");
  });

  it("matches structured network prefixes, never legacy grants, sibling commands or changed executable bytes", () => {
    const exe = path.resolve("git.exe"), hash = "a".repeat(64);
    const fetch = networkCommandApprovalPrefix(exe, ["fetch"], hash);
    const push = networkCommandApprovalPrefix(exe, ["push"], hash);
    const grants = grantCommandApprovalPrefix([], fetch);
    assert.equal(isCommandApprovalPrefixGranted(grants, fetch), true);
    assert.equal(isCommandApprovalPrefixGranted(grants, push), false);
    assert.equal(isCommandApprovalPrefixGranted(grants, networkCommandApprovalPrefix(exe, ["fetch-other"], hash)), false);
    assert.equal(isCommandApprovalPrefixGranted(grants, networkCommandApprovalPrefix(exe, ["fetch"], "b".repeat(64))), false);
    assert.equal(isCommandApprovalPrefixGranted([exe], fetch), false);
    const broad = grantCommandApprovalPrefix([], networkCommandApprovalPrefix(exe, [], hash));
    assert.equal(isCommandApprovalPrefixGranted(broad, push), true);
    assert.throws(() => networkCommandApprovalPrefix(exe, ["bad\nargument"], hash));
  });

  it("replays grants and revocation from authoritative events across Resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-network-grant-"));
    const storage = createStorage(root);
    try {
      const store = new ThreadStore(storage);
      store.create({ threadId: "network", workspaceRoot: path.join(root, "workspace"), mode: "code", provider: "deepseek", model: "test" });
      const prefix = networkCommandApprovalPrefix(process.execPath, [], "a".repeat(64));
      store.recordCommandApprovalPrefixGrant("network", prefix);
      assert.equal(isCommandApprovalPrefixGranted(store.recover("network").commandApprovalPrefixes, prefix), true);
      store.recordCommandApprovalPrefixRevocation("network", prefix);
      assert.deepEqual(store.recover("network").commandApprovalPrefixes, []);
    } finally { storage.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("denies without resolving DNS, and rejects missing or cross-command credentials", async () => {
    let approvals = 0, resolutions = 0;
    const gate = await createCommandNetworkGate({ authorize: async () => { approvals++; return false; }, record: () => {},
      resolveHost: async () => { resolutions++; return "127.0.0.1"; } });
    const other = await createCommandNetworkGate({ authorize: async () => true, record: () => {} });
    try {
      assert.equal((await proxyRequest(gate.proxyURL, "http://fixture.test/")).status, 403);
      assert.equal(approvals, 1); assert.equal(resolutions, 0);
      assert.equal((await proxyRequest(gate.proxyURL, "http://fixture.test/", "", false)).status, 403);
      const wrong = new URL(gate.proxyURL); wrong.password = new URL(other.proxyURL).password;
      assert.equal((await proxyRequest(wrong.href, "http://fixture.test/")).status, 403);
      assert.equal(approvals, 1);
    } finally { await gate.close(); await other.close(); }
  });

  it("forwards an approved request once, preserving the body after an approval wait", async () => {
    let received = "", requests = 0, credentialLeaked = false;
    const server = createServer((req, res) => {
      requests++; credentialLeaked = req.headers["proxy-authorization"] !== undefined;
      req.on("data", c => { received += String(c); }); req.once("end", () => res.end("accepted"));
    });
    const port = await listen(server);
    const gate = await createCommandNetworkGate({ authorize: async () => { await new Promise(r => setTimeout(r, 20)); return true; }, record: () => {}, resolveHost: async () => "127.0.0.1" });
    try {
      const body = "fixture".repeat(10000);
      assert.deepEqual(await proxyRequest(gate.proxyURL, `http://fixture.test:${port}/upload`, body), { status: 200, text: "accepted" });
      assert.equal(received, body); assert.equal(requests, 1); assert.equal(credentialLeaked, false);
    } finally { await gate.close(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("preserves early CONNECT data and closes tunnel sockets with the command", async () => {
    const server = createTcpServer(socket => socket.pipe(socket));
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const gate = await createCommandNetworkGate({ authorize: async () => { await new Promise(r => setTimeout(r, 20)); return true; }, record: () => {}, resolveHost: async () => "127.0.0.1" });
    const url = new URL(gate.proxyURL);
    const client = connect(Number(url.port), url.hostname);
    try {
      const reply = new Promise<string>((resolve, reject) => {
        let text = ""; client.on("data", c => { text += String(c); if (text.includes("early-body")) resolve(text); });
        client.once("error", reject); client.setTimeout(3000, () => reject(new Error("CONNECT timed out")));
      });
      client.write(`CONNECT fixture.test:${address.port} HTTP/1.1\r\nHost: fixture.test:${address.port}\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}\r\n\r\nearly-body`);
      assert.match(await reply, /200 Connection Established/u);
      const closed = new Promise<void>(r => client.once("close", () => r()));
      await gate.close(); await closed;
    } finally { client.destroy(); await gate.close(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("does not open private, metadata or IPv6 connections even after authorization", async () => {
    for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"]) await assert.rejects(() => resolvePublicNetworkHost(host));
  });

  it("chains the installed SRT HTTP proxy through the gate without its implicit localhost bypass", async () => {
    for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.1", "2130706433", "[::1]", "[::ffff:127.0.0.1]", "169.254.169.254"]) assert.equal(allowBrokeredNetworkHost(host), false, host);
    let accepted = 0, grants = 0;
    const target = createServer((_req, res) => { accepted++; res.end("srt-chain-ok"); });
    const port = await listen(target);
    const gate = await createCommandNetworkGate({ authorize: async () => { grants++; return true; }, record: () => {}, resolveHost: async () => "127.0.0.1" });
    const proxy = createHttpProxyServer({ filter: (_port, host) => allowBrokeredNetworkHost(host), proxyAuthToken: "fixture-only",
      parentProxy: resolveParentProxy({ http: gate.proxyURL, https: gate.proxyURL, noProxy: "" }) });
    const proxyPort = await listen(proxy);
    try {
      const url = `http://srt:fixture-only@127.0.0.1:${proxyPort}`;
      assert.equal((await proxyRequest(url, `http://localhost:${port}/`)).status, 403);
      assert.equal(accepted, 0); assert.equal(grants, 0);
      assert.deepEqual(await proxyRequest(url, `http://fixture.test:${port}/`), { status: 200, text: "srt-chain-ok" });
      assert.equal(accepted, 1); assert.equal(grants, 1);
    } finally { await gate.close(); await new Promise<void>(r => proxy.close(() => r())); await new Promise<void>(r => target.close(() => r())); }
  });

  it("enforces the mode matrix before starting known network commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-network-runtime-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      let starts = 0, requestCount = 0;
      const metadata = { backend: "host-test-only", enforced: false, filesystem: "host", network: "host" } as const;
      const backend: CommandExecutionBackend = { describe: () => metadata, prepare: async (_request) => {
        starts++; return { executablePath: process.execPath, args: ["--version"], cwdAbsolute: root, environment: { ...process.env }, metadata, cleanup: async () => {} };
      } };
      for (const mode of ["manual", "auto_approve", "unrestricted"] as CommandExecutionMode[]) {
        for (const args of [["https://example.invalid/doc"], ["--output", "file", "https://example.invalid/file"], ["--data", "body", "https://example.invalid/upload"]]) {
          const before = starts, prompts = requestCount;
          const context: ToolContext = { workspaceRoot: root, mode: "code", threadId: "network", turnId: "turn", commandExecutionMode: mode,
            approvalPolicy: "safe", requestApproval: async (r: ApprovalRequest) => { requestCount++; assert.ok(r.network); return false; }, commandTimeoutMs: 1000, maxOutputChars: 1000 };
          const output = await new CommandRuntime(workspace, undefined, backend).run({ program: "curl", args, intent: "inspect" }, context);
          const allowed = mode === "unrestricted" || mode === "auto_approve" && args.length === 1;
          assert.equal(output.status, allowed ? "exited" : "policy_denied");
          assert.equal(starts - before, allowed ? 1 : 0); assert.equal(requestCount - prompts, allowed ? 0 : 1);
        }
      }
      const dangerous: ToolContext = { workspaceRoot: root, mode: "code", threadId: "network", turnId: "turn", commandExecutionMode: "unrestricted", approvalPolicy: "ask",
        requestApproval: async () => { throw new Error("Dangerous mode must not prompt"); }, commandTimeoutMs: 1000, maxOutputChars: 1000 };
      assert.equal((await new CommandRuntime(workspace, undefined, backend, undefined, { networkProfile: "benchmark" }).run({ program: "curl", args: ["https://example.invalid"], intent: "run" }, dangerous)).status, "policy_denied");
      assert.equal((await new CommandRuntime(workspace, undefined, backend).run({ program: process.execPath, args: ["-e", "let a = 1;\nconsole.log(a)"], cwd: root, intent: "run" }, dangerous)).status, "exited");
      // The backend intentionally substitutes node --version; never launch a
      // detached or encoded target on the test host. Test only Runtime routing.
      const shell = process.platform === "win32" ? { program: "powershell", args: ["-EncodedCommand", "fixture"] } : { program: "sh", args: ["-lc", "echo fixture"] };
      assert.equal((await new CommandRuntime(workspace, undefined, backend).run({ ...shell, intent: "run" }, dangerous)).status, "exited");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("gates unknown scripts at the actual network attempt and asks only once after denial", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-network-dynamic-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      let prompts = 0; const observed: SandboxExecutionRequest[] = [];
      const metadata = { backend: "host-test-only", enforced: false, filesystem: "host", network: "host" } as const;
      const backend: CommandExecutionBackend = { describe: () => metadata, prepare: async req => {
        observed.push(req); assert.ok(req.networkProxyURL);
        for (let i = 0; i < 2; i++) assert.equal((await proxyRequest(req.networkProxyURL, "http://127.0.0.1/")).status, 403);
        return { executablePath: process.execPath, args: ["--version"], cwdAbsolute: root, environment: { ...process.env }, metadata, cleanup: async () => {} };
      } };
      const context: ToolContext = { workspaceRoot: root, mode: "code", threadId: "network", turnId: "turn", commandExecutionMode: "auto_approve", approvalPolicy: "safe",
        requestApproval: async r => { assert.equal(r.network?.effect, "unknown"); prompts++; return false; }, commandTimeoutMs: 1000, maxOutputChars: 1000 };
      await new CommandRuntime(workspace, undefined, backend).run({ program: "node", args: ["--version"], intent: "inspect" }, context);
      assert.equal(prompts, 1);
      await assert.rejects(() => proxyRequest(observed[0]!.networkProxyURL!, "http://127.0.0.1/"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
