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

  it("rejects direct wait/detach workarounds with handle-based recovery guidance", () => {
    for (const program of ["sleep", "nohup", "timeout", "C:\\Windows\\timeout.exe"]) {
      const failure = validateCommandRequest({ program, args: ["30"] });
      assert.equal(failure?.matchedRule, "input.async_workaround", program);
      assert.match(failure?.reason ?? "", /process was not started/iu);
      assert.match(failure?.recommendation ?? "", /action=start/iu);
      assert.match(failure?.recommendation ?? "", /action=status/iu);
      assert.match(failure?.recommendation ?? "", /waitMs/u);
    }
  });

  it("reports duplicate-program recovery before other input guidance", () => {
    const failure = validateCommandRequest({ program: "sleep", args: ["sleep", "30"] });
    assert.equal(failure?.matchedRule, "input.duplicate_program_argument");
    assert.match(failure?.reason ?? "", /args\[0\].*repeats program/iu);
    assert.match(failure?.recommendation ?? "", /remove the duplicate first item/iu);
    assert.match(failure?.recommendation ?? "", /action=start/iu);
    assert.match(failure?.recommendation ?? "", /action=status/iu);
  });
});
