import assert from "node:assert/strict";
import { hostPlatform } from "../src/core/host-platform.js";
import { createCommandWorker } from "../src/command/platform/index.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { WindowsNativeStartup } from "../src/sandbox/platform/windows-startup.js";
import { MacNativeStartup } from "../src/sandbox/platform/macos-startup.js";
import { LinuxNativeStartup } from "../src/sandbox/platform/linux-startup.js";
import { WindowsNativeBackend } from "../src/sandbox/platform/windows-backend.js";
import { MacNativeBackend } from "../src/sandbox/platform/macos-backend.js";
import { LinuxNativeBackend } from "../src/sandbox/platform/linux-backend.js";
import type { ReadinessResult } from "../src/sandbox/platform/startup-types.js";
import { describe, it } from "./harness.js";

describe("platform service selection", () => {
  it("selects independent command supervisors for each supported host", () => {
    assert.equal(createCommandWorker(hostPlatform("win32")).detached, false);
    assert.equal(createCommandWorker(hostPlatform("darwin")).detached, true);
    assert.equal(createCommandWorker(hostPlatform("linux")).detached, true);
    assert.throws(() => hostPlatform("freebsd"), /Unsupported host platform/u);
  });

  it("keeps sandbox probe and execution policy in each platform implementation", () => {
    const options = { limits: DEFAULT_RUNTIME_LIMITS, dataDir: "C:\\easy-code-data", report: () => undefined };
    const windows = new WindowsNativeStartup(options);
    const mac = new MacNativeStartup(options);
    const linux = new LinuxNativeStartup(options);
    assert.match(windows.backendName, /Windows/u);
    assert.match(mac.backendName, /macOS/u);
    assert.match(linux.backendName, /Linux/u);
    assert.equal(windows.checkProbe("HOST\\CodexSandboxOffline", () => { throw new Error("unexpected"); }), undefined);
    const result: ReadinessResult = (status, details, canSetup = false) => ({
      status, details, canSetup, platform: "linux", backend: "test", warnings: [],
    });
    assert.equal(mac.probeFailed("operation failed", result).status, "probe_failed");
    assert.equal(linux.probeFailed("bubblewrap not found", result).status, "dependencies_missing");

    const backendOptions = { ...options, home: "C:\\easy-code-home", workspaceRoot: "C:\\workspace" };
    const implementations = [
      new WindowsNativeBackend(backendOptions),
      new MacNativeBackend(backendOptions),
      new LinuxNativeBackend(backendOptions),
    ];
    assert.deepEqual(implementations.map(value => value.sandboxManagedTimeout), [true, false, true]);
    assert.deepEqual(implementations.map(value => value.cooperativeTermination), [false, true, true]);
  });
});
