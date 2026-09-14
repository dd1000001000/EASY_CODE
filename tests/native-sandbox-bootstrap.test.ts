import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { needsWindowsBootstrapCompatibility } from "../src/sandbox/native-startup.js";
import {
  NATIVE_SANDBOX_BOOTSTRAP_VERSION,
  nativeSandboxBootstrapEntrypoint,
} from "../src/sandbox/native-runtime.js";
import { hasRetiredSrtDenyAcl, retiredSrtAccount } from "../src/sandbox/windows-bootstrap.js";
import { describe, it } from "./harness.js";

describe("Windows native sandbox bootstrap compatibility", () => {
  it("uses the compatibility bootstrap only for the known fresh-install regression", () => {
    const failure = new Error("helper_sandbox_lock_failed: lock sandbox bin dir C:\\state\\.sandbox-bin failed");
    assert.equal(needsWindowsBootstrapCompatibility(failure, "0.154.0"), true);
    assert.equal(needsWindowsBootstrapCompatibility(failure, "0.153.4"), false);
    assert.equal(needsWindowsBootstrapCompatibility(new Error("UAC was declined"), "0.154.0"), false);
  });

  it("recognizes only the retired SRT account and constructs its local identity", () => {
    assert.equal(hasRetiredSrtDenyAcl("HOST\\srt-sandbox:(DENY)(DC)"), true);
    assert.equal(hasRetiredSrtDenyAcl("HOST\\CodexSandboxUsers:(RX)"), false);
    assert.equal(retiredSrtAccount({ COMPUTERNAME: "HOST" }), "HOST\\srt-sandbox");
    assert.equal(retiredSrtAccount({}), "srt-sandbox");
  });

  it("ships the known-good bootstrap binary on supported Windows installations", () => {
    assert.equal(NATIVE_SANDBOX_BOOTSTRAP_VERSION, "0.153.4");
    if (process.platform === "win32") {
      assert.equal(existsSync(nativeSandboxBootstrapEntrypoint()), true);
    }
  });
});
