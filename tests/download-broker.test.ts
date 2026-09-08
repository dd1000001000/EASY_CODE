import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvedRedirect, assertArtifactURL, DownloadBroker, publicDownloadAddress, verifyArtifact } from "../src/downloads/broker.js";
import { FetchArtifactTool } from "../src/tools/fetch-artifact.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { sha256 } from "../src/utils/hash.js";
import { describe, it } from "./harness.js";

const body = Buffer.from("immutable dependency fixture");
const integrity = `sha256-${createHash("sha256").update(body).digest("base64")}`;

async function fixture(run: (root: string, workspace: WorkspaceManager, config: string, cache: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-download-test-"));
  try {
    const workspace = path.join(root, "workspace"), config = path.join(root, "config"), cache = path.join(root, "cache");
    await Promise.all([workspace, config, cache].map(directory => mkdir(directory)));
    await run(root, await WorkspaceManager.create(workspace), config, cache);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("controlled artifact downloads", () => {
  it("rejects private, loopback, metadata and non-HTTPS destinations", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "198.18.0.1", "224.0.0.1"]) assert.equal(publicDownloadAddress(address), false);
    assert.equal(publicDownloadAddress("8.8.8.8"), true);
    for (const url of ["http://registry.npmjs.org/x", "https://127.0.0.1/x", "https://localhost/x", "https://host.local/x", "https://u:p@example.com/x", "https://example.com:8443/x", "https://example.com/x#fragment"]) assert.throws(() => assertArtifactURL(url));
  });

  it("requires exact redirect authorization and preserves full integrity", () => {
    const from = new URL("https://example.com/a");
    assert.throws(() => approvedRedirect(from, "/search?q=answer", []), /authorized/u);
    assert.throws(() => approvedRedirect(from, "https://127.0.0.1/x", ["https://127.0.0.1/x"]));
    assert.equal(approvedRedirect(from, "/a.tgz", ["https://example.com/a.tgz"]).pathname, "/a.tgz");
    verifyArtifact(body, integrity);
    assert.throws(() => verifyArtifact(Buffer.from("different bytes"), integrity), /integrity mismatch/u);
  });

  it("fetches only catalogued verified bytes and never overwrites changed destinations", async () => {
    await fixture(async (_root, workspace, config, cache) => {
      await writeFile(path.join(config, "artifact-catalog.json"), JSON.stringify({ version: 1, artifacts: [{ id: "fixture", kind: "file", url: "https://example.com/fixture.bin", integrity, filename: "fixture.bin", maxBytes: 1000, workspaceRoot: workspace.root }] }));
      await mkdir(path.join(cache, "approved-artifacts"));
      await writeFile(path.join(cache, "approved-artifacts", sha256(integrity)), body);
      const broker = await DownloadBroker.create(workspace, config, cache, "test");
      assert.equal(broker.list().artifacts.length, 1);
      await assert.rejects(() => broker.fetch("https://example.com/search"), /not in the trusted/u);
      const fetched = await broker.fetch("fixture");
      assert.equal(fetched.cached, true);
      assert.deepEqual(await readFile(path.join(workspace.root, fetched.path)), body);
      await writeFile(path.join(workspace.root, fetched.path), "user edit");
      await assert.rejects(() => broker.fetch("fixture"), /integrity mismatch/u);
      assert.equal(await readFile(path.join(workspace.root, fetched.path), "utf8"), "user edit");
      const context = { workspaceRoot: workspace.root, mode: "plan" as const, threadId: "thread", turnId: "turn", approvalPolicy: "safe" as const, requestApproval: async () => true, commandTimeoutMs: 1000, maxOutputChars: 1000 };
      const tool = new FetchArtifactTool(broker);
      assert.equal((await tool.execute({ action: "fetch", artifactId: "fixture" }, context)).ok, false);
      assert.equal((await tool.execute({ action: "list", url: "https://example.com" }, { ...context, mode: "code" })).ok, false);
      assert.equal((await tool.execute({ action: "fetch", artifactId: "fixture" }, { ...context, mode: "code", agentRole: "subagent" })).ok, false);
    });
  });

  it("does not let an edited lock or Resume manufacture download authority", async () => {
    await fixture(async (_root, workspace, config, cache) => {
      await writeFile(path.join(workspace.root, "package.json"), "{}");
      const lock = { lockfileVersion: 3, packages: { "node_modules/fixture": { resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", integrity } } };
      await writeFile(path.join(workspace.root, "package-lock.json"), JSON.stringify(lock));
      const broker = await DownloadBroker.create(workspace, config, cache, "same-thread");
      const id = broker.list().artifacts[0]!.id;
      lock.packages["node_modules/fixture"].resolved = "https://registry.npmjs.org/other/-/other-1.0.0.tgz";
      await writeFile(path.join(workspace.root, "package-lock.json"), JSON.stringify(lock));
      const restored = await DownloadBroker.create(workspace, config, cache, "same-thread");
      assert.equal(restored.list().artifacts[0]!.id, id);
      await assert.rejects(() => restored.fetch(id), /manifest changed/u);
    });
  });

  it("tolerates unsupported project locks without adding authority", async () => {
    await fixture(async (_root, workspace, config, cache) => {
      await writeFile(path.join(workspace.root, "package.json"), "{}");
      await writeFile(path.join(workspace.root, "package-lock.json"), "{ broken");
      assert.deepEqual((await DownloadBroker.create(workspace, config, cache)).list().artifacts, []);
      await assert.rejects(() => DownloadBroker.create(workspace, workspace.root, cache), /outside/u);
    });
  });
});
