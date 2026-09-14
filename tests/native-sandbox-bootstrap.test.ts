import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  nativeSandboxEntrypoint,
  nativeSandboxHome,
  nativeSandboxRuntimeVersion,
} from "../src/sandbox/native-runtime.js";
import { describe, it } from "./harness.js";

describe("native sandbox runtime identity", () => {
  it("uses one installed runtime for setup and execution", () => {
    assert.equal(nativeSandboxRuntimeVersion(), "0.153.4");
    assert.match(nativeSandboxHome("C:\\data"), /runtime-home-v2$/u);
  });

  it("ships the selected platform runtime without a second bootstrap binary", () => {
    if (process.platform === "win32") {
      assert.equal(existsSync(nativeSandboxEntrypoint()), true);
    }
  });
});
