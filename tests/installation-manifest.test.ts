import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  beginOwnedResource,
  completeOwnedResource,
  installationManifestPath,
  readOwnedResources,
  recordOwnedResource,
} from "../src/install/ownership.js";
import { buildFilePlan } from "../src/uninstall/plan.js";
import { describe, it } from "./harness.js";

async function fixture(run: (home: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-install-manifest-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  try {
    await run(home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("current installation manifest", () => {
  it("atomically records creating and ready resource identities", async () => fixture(async (home) => {
    const data = path.join(home, "current-data");
    beginOwnedResource({ kind: "data", path: data }, home);
    let resource = readOwnedResources(home).find((item) => item.path === data);
    assert.equal(resource?.state, "creating");
    assert.equal(resource?.identity, undefined);

    mkdirSync(data);
    completeOwnedResource({ kind: "data", path: data }, home);
    const config = path.dirname(installationManifestPath(home));
    recordOwnedResource({ kind: "config", path: config }, home);
    resource = readOwnedResources(home).find((item) => item.path === data);
    assert.equal(resource?.state, "ready");
    assert.match(resource?.identity ?? "", /^fs:\d+:\d+$/u);

    const manifest = JSON.parse(readFileSync(installationManifestPath(home), "utf8")) as { version: number };
    assert.equal(manifest.version, 2);
    assert.equal(readdirSync(config).some((name) => name.endsWith(".tmp")), false);
    const plan = await buildFilePlan({ home });
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.actions.some((action) => path.resolve(action.target) === path.resolve(data)));
    assert.ok(plan.actions.some((action) => path.resolve(action.target) === path.resolve(config)));
  }));

  it("rejects an unsupported manifest without mutating it", async () => fixture(async (home) => {
    const data = path.join(home, "current-data");
    mkdirSync(data);
    recordOwnedResource({ kind: "data", path: data }, home);
    const file = installationManifestPath(home);
    const unsupported = readFileSync(file, "utf8").replace('"version": 2', '"version": 1');
    writeFileSync(file, unsupported);
    assert.throws(() => readOwnedResources(home), /unsupported EASY CODE development format/u);
    const plan = await buildFilePlan({ home });
    assert.match(plan.blockers.join("\n"), /unsupported EASY CODE development format/u);
    assert.equal(plan.actions.length, 0);
    assert.equal(readFileSync(file, "utf8"), unsupported);
    assert.equal(existsSync(data), true);
  }));

  it("collapses nested current roots into one stable deletion action", async () => fixture(async (home) => {
    const data = path.join(home, "current-data");
    const cache = path.join(data, "cache");
    mkdirSync(cache, { recursive: true });
    recordOwnedResource({ kind: "data", path: data }, home);
    recordOwnedResource({ kind: "cache", path: cache }, home);

    const plan = await buildFilePlan({ home });
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.actions.some((action) => path.resolve(action.target) === path.resolve(data)));
    assert.equal(plan.actions.some((action) => path.resolve(action.target) === path.resolve(cache)), false);
  }));
});
