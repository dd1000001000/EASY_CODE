import assert from "node:assert/strict";

import {
  hasDuplicateProgramArgument,
  validateCommandRequest,
} from "../src/command/request-validation.js";
import { describe, it } from "./harness.js";

describe("command request validation", () => {
  it("detects an executable repeated as the first structured argument", () => {
    for (const input of [
      { program: "sleep", args: ["sleep", "5"] },
      { program: "node.exe", args: ["node", "script.cjs"] },
      { program: "C:\\Tools\\Node.EXE", args: ["node.exe", "script.cjs"] },
      { program: "./scripts/check", args: ["./scripts/check", "--quick"] },
      { program: "./scripts/check", args: ["check", "--quick"] },
    ]) {
      assert.equal(hasDuplicateProgramArgument(input), true, JSON.stringify(input));
    }
  });

  it("does not confuse a real first argument with the executable", () => {
    for (const input of [
      { program: "sleep", args: ["5"] },
      { program: "node", args: ["script.cjs"] },
      { program: "cmd", args: ["/c", "dir"] },
      { program: "git", args: [] },
      { program: "git" },
    ]) {
      assert.equal(hasDuplicateProgramArgument(input), false, JSON.stringify(input));
    }
  });

  it("rejects detach workarounds but allows ordinary bounded waiting", () => {
    for (const program of ["nohup", "disown"]) {
      const failure = validateCommandRequest({ program, args: ["30"] });
      assert.equal(failure?.matchedRule, "input.async_workaround", program);
      assert.match(failure?.reason ?? "", /process was not started/iu);
      assert.match(failure?.recommendation ?? "", /real executable directly/iu);
      assert.match(failure?.recommendation ?? "", /timeoutMs/u);
    }
    for (const program of ["sleep", "timeout", "C:\\Windows\\timeout.exe"]) assert.equal(validateCommandRequest({ program, args: ["1"] }), undefined);
  });

  it("does not reject potentially legitimate same-name argv", () => {
    const failure = validateCommandRequest({ program: "sleep", args: ["sleep", "30"] });
    assert.equal(failure, undefined);
  });

  it("leaves verification metadata correction to the shared normalizer", () => {
    assert.equal(
      validateCommandRequest({
        program: "npm",
        args: ["run", "lint"],
        intent: "verify",
        verificationKind: "lint",
      }),
      undefined,
    );
    assert.equal(
      validateCommandRequest({
        program: "npm",
        args: ["run", "lint"],
        intent: "verify",
      })?.matchedRule,
      undefined,
    );
    assert.equal(
      validateCommandRequest({
        program: "npm",
        args: ["--version"],
        intent: "inspect",
        verificationKind: "smoke_test",
      })?.matchedRule,
      undefined,
    );
  });
});
