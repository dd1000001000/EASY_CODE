import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localModelEnvironment, sharedLayaEndpoint } from "../src/local-decision/endpoint.js";
import { describe, it } from "./harness.js";

describe("shared Laya endpoint identity", () => {
  it("shares one worker version but separates different code and Python environments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-laya-identity-"));
    const workerPath = path.join(root, "worker.py");
    try {
      await writeFile(workerPath, "version one");
      const options = { dataDir: root, python: path.join(root, "python"), workerPath };
      const first = sharedLayaEndpoint(options);
      assert.equal(sharedLayaEndpoint(options).address, first.address);
      assert.notEqual(sharedLayaEndpoint({ ...options, python: path.join(root, "other-python") }).address,
        first.address);
      await writeFile(workerPath, "version two");
      assert.notEqual(sharedLayaEndpoint(options).address, first.address);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not carry provider credentials into the long-lived service", () => {
    const name = "EASY_CODE_LOCAL_DECISION_TEST_SECRET";
    const previous = process.env[name];
    try {
      process.env[name] = "do-not-inherit";
      assert.equal(localModelEnvironment()[name], undefined);
      assert.equal(localModelEnvironment().HF_HUB_OFFLINE, "1");
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
