import assert from "node:assert/strict";
import os from "node:os";
import { currentProcessIdentity, inspectProcess, processOwnerState, type ProcessSnapshot } from "../src/core/process-owner.js";
import { describe, it } from "./harness.js";

describe("process-incarnation ownership", () => {
  const owner = { pid: 28340, hostname: os.hostname(), processIdentity: { started: "old-birth", executable: process.execPath } };
  const present = (started: string, name = "node.exe"): ProcessSnapshot => ({ state: "present", name,
    identity: { started, executable: process.execPath } });
  it("does not confuse a reused PID with the recorded owner, even for another Node process", () => {
    assert.equal(processOwnerState(owner, () => present("old-birth")), "active");
    assert.equal(processOwnerState(owner, () => present("new-birth")), "inactive");
    assert.equal(processOwnerState(owner, () => ({ state: "absent" })), "inactive");
  });
  it("handles legacy conhost reuse without treating unverified Node owners as dead", () => {
    const legacy = { pid: owner.pid, hostname: owner.hostname };
    assert.equal(processOwnerState(legacy, () => ({ state: "present", name: "conhost.exe", identity: { started: "new-birth", executable: "C:\\Windows\\System32\\conhost.exe" } })), "inactive");
    assert.equal(processOwnerState(legacy, () => present("new-birth")), "unknown");
  });
  it("preserves unreadable, foreign-host and malformed ownership without signaling processes", () => {
    assert.equal(processOwnerState(owner, () => ({ state: "unknown" })), "unknown");
    assert.equal(processOwnerState({ ...owner, hostname: "another-host" }, () => { throw new Error("must not probe"); }), "unknown");
    assert.equal(processOwnerState({ ...owner, processIdentity: {} }, () => present("new-birth")), "unknown");
  });
  it("captures a stable real process identity and recognizes its current incarnation", () => {
    const identity = currentProcessIdentity(); assert.ok(identity);
    assert.deepEqual(currentProcessIdentity(), identity);
    assert.equal(inspectProcess(process.pid).state, "present");
    assert.equal(processOwnerState({ pid: process.pid, hostname: os.hostname(), processIdentity: identity }), "active");
  });
});
