import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { stopPosixProcessGroup } from "../src/sandbox/posix-process-group.js";

const gone = (): never => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
describe("POSIX process-group cleanup (not escaped-descendant containment)", () => {
  it("accepts an already empty group", async () => {
    assert.equal(await stopPosixProcessGroup(123, 0, gone), true);
  });
  it("rejects unsafe identifiers without sending any signal", async () => {
    for (const pid of [0, 1, -123, NaN, 1.5]) {
      assert.equal(await stopPosixProcessGroup(pid, 0, () => assert.fail("unsafe signal")), false);
    }
  });
  it("checks only its own group and escalates to KILL after grace", async () => {
    const calls: (NodeJS.Signals | 0)[] = [];
    assert.equal(await stopPosixProcessGroup(123, 0, (pid, signal) => {
      assert.equal(pid, -123); calls.push(signal);
      if (signal === 0 && calls.includes("SIGKILL")) gone();
    }), true);
    assert.deepEqual(calls, ["SIGTERM", 0, "SIGKILL", 0]);
  });
  it("never treats permission errors or unknown errors as a confirmed exit", async () => {
    for (const code of ["EPERM", "EIO", undefined]) {
      assert.equal(await stopPosixProcessGroup(123, 0, () => { throw Object.assign(new Error("unknown"), { code }); }), false);
    }
  });
  it("reports surviving groups unconfirmed after the bounded attempts", async () => {
    assert.equal(await stopPosixProcessGroup(123, 0, () => undefined), false);
  });
});
