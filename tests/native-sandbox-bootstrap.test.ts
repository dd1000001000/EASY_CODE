import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { parse as parseToml } from "toml";

import {
  nativeSandboxEntrypoint,
  nativeSandboxHome,
  nativeSandboxRuntimeVersion,
} from "../src/sandbox/native-runtime.js";
import {
  NATIVE_PROJECT_PERMISSION_PROFILE,
  NATIVE_PROJECT_READ_ONLY_PROFILE,
  NATIVE_SERVICE_PERMISSION_PROFILE,
  nativeProjectPermissionConfig,
} from "../src/sandbox/native-policy.js";
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

  it("grants every logical-project folder through named permission profiles", () => {
    const roots = process.platform === "win32"
      ? ["C:\\work\\primary", "D:\\work\\secondary"]
      : ["/work/primary", "/work/secondary"];
    const config = parseToml(nativeProjectPermissionConfig(roots)) as any;
    assert.equal(config.default_permissions, NATIVE_PROJECT_PERMISSION_PROFILE);
    assert.equal(config.windows.sandbox, "elevated");
    for (const profileName of [NATIVE_PROJECT_PERMISSION_PROFILE, NATIVE_PROJECT_READ_ONLY_PROFILE,
      NATIVE_SERVICE_PERMISSION_PROFILE]) {
      const profile = config.permissions[profileName];
      assert.deepEqual(Object.keys(profile.workspace_roots), roots);
      assert.ok(profile.filesystem[":workspace_roots"]);
    }
    assert.equal(config.permissions[NATIVE_SERVICE_PERMISSION_PROFILE].network.allow_local_binding, true);
    assert.equal(config.permissions[NATIVE_SERVICE_PERMISSION_PROFILE].network.domains.localhost, "allow");
  });
});
