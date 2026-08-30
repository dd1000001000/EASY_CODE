import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, it } from "./harness.js";

interface SandboxPrerequisiteResult {
  ready: boolean;
  platform: string;
  status: "ready" | "setup_required" | "dependencies_missing" | "unsupported" | "check_failed";
  problems?: string[];
}

interface SandboxRuntimeStub {
  SandboxManager: {
    isSupportedPlatform(): boolean;
    checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }>;
  };
  VENDORED_SRT_WIN_EXE: string;
  resolveSrtWin(input: { path: string }): unknown;
  checkWindowsSandboxStatusAsync(input: { srtWin: unknown }): Promise<{
    user: {
      provisioned: boolean;
      credPresent: boolean;
      groupExists: boolean;
      inSandboxGroup: boolean;
    };
  }>;
  verifyWindowsWfpEgress(input: { srtWin: unknown }): Promise<void>;
  installWindowsSandboxAsync(): Promise<void>;
}

interface PostinstallModule {
  checkSandboxPrerequisites(options: {
    stdout: TextSink;
    stderr: TextSink;
    platform: NodeJS.Platform;
    loadRuntime: () => Promise<SandboxRuntimeStub>;
  }): Promise<SandboxPrerequisiteResult>;
}

class TextSink {
  value = "";

  write(chunk: unknown): boolean {
    this.value += String(chunk);
    return true;
  }
}

const require = createRequire(import.meta.url);
const postinstall = require(
  path.join(process.cwd(), "scripts", "postinstall.cjs"),
) as PostinstallModule;

async function withoutChildProcesses<T>(run: () => Promise<T>): Promise<T> {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const methodNames = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"];
  const originals = new Map<string, unknown>();
  const attempts: string[] = [];
  try {
    for (const methodName of methodNames) {
      originals.set(methodName, childProcess[methodName]);
      childProcess[methodName] = () => {
        attempts.push(methodName);
        throw new Error(`Unexpected child process via ${methodName}`);
      };
    }
    const result = await run();
    assert.deepEqual(attempts, [], "sandbox prerequisite check attempted to run a package manager");
    return result;
  } finally {
    for (const [methodName, original] of originals) {
      childProcess[methodName] = original;
    }
  }
}

function runtimeStub(options: {
  supported?: boolean;
  windowsReady?: boolean;
  dependencyErrors?: string[];
  dependencyWarnings?: string[];
  onInstall?: () => void;
  onVerifyWindows?: () => void;
} = {}): SandboxRuntimeStub {
  return {
    SandboxManager: {
      isSupportedPlatform: () => options.supported ?? true,
      checkDependenciesAsync: async () => ({
        errors: options.dependencyErrors ?? [],
        warnings: options.dependencyWarnings ?? [],
      }),
    },
    VENDORED_SRT_WIN_EXE: "C:\\Program Files\\EASY CODE\\srt-win.exe",
    resolveSrtWin: ({ path: executable }) => ({ exe: executable, prependArgs: [] }),
    checkWindowsSandboxStatusAsync: async () => {
      const ready = options.windowsReady ?? false;
      return {
        user: {
          provisioned: ready,
          credPresent: ready,
          groupExists: ready,
          inSandboxGroup: ready,
        },
      };
    },
    verifyWindowsWfpEgress: async () => {
      options.onVerifyWindows?.();
    },
    installWindowsSandboxAsync: async () => {
      options.onInstall?.();
      throw new Error("The read-only prerequisite check must never install the Windows sandbox");
    },
  };
}

async function runCheck(
  platform: NodeJS.Platform,
  loadRuntime: () => Promise<SandboxRuntimeStub>,
): Promise<{ result: SandboxPrerequisiteResult; stdout: string; stderr: string }> {
  const stdout = new TextSink();
  const stderr = new TextSink();
  let result: SandboxPrerequisiteResult | undefined;
  await assert.doesNotReject(async () => {
    result = await withoutChildProcesses(() =>
      postinstall.checkSandboxPrerequisites({ stdout, stderr, platform, loadRuntime }),
    );
  });
  assert.ok(result, "sandbox prerequisite check did not return a result");
  return { result, stdout: stdout.value, stderr: stderr.value };
}

describe("postinstall sandbox prerequisite check", () => {
  it("reports an uninitialized Windows sandbox without installing it", async () => {
    let installCalls = 0;
    let verifyCalls = 0;
    const runtime = runtimeStub({
      windowsReady: false,
      onInstall: () => { installCalls += 1; },
      onVerifyWindows: () => { verifyCalls += 1; },
    });

    const checked = await runCheck("win32", async () => runtime);

    assert.deepEqual(checked.result, {
      ready: false,
      platform: "win32",
      status: "setup_required",
    });
    assert.equal(installCalls, 0);
    assert.equal(verifyCalls, 0);
    assert.match(checked.stdout, /needs one-time setup/u);
    assert.equal(checked.stderr, "");
  });

  it("reports a ready Windows sandbox without reinstalling it", async () => {
    let installCalls = 0;
    let verifyCalls = 0;
    const runtime = runtimeStub({
      windowsReady: true,
      onInstall: () => { installCalls += 1; },
      onVerifyWindows: () => { verifyCalls += 1; },
    });

    const checked = await runCheck("win32", async () => runtime);

    assert.deepEqual(checked.result, { ready: true, platform: "win32", status: "ready" });
    assert.equal(installCalls, 0);
    assert.equal(verifyCalls, 1);
    assert.match(checked.stdout, /prerequisites are ready/u);
    assert.equal(checked.stderr, "");
  });

  it("reports missing Linux dependencies without invoking a package manager", async () => {
    let installCalls = 0;
    const runtime = runtimeStub({
      dependencyErrors: ["bubblewrap (bwrap) not installed"],
      dependencyWarnings: ["seccomp not available\nmanual setup required"],
      onInstall: () => { installCalls += 1; },
    });

    const checked = await runCheck("linux", async () => runtime);

    assert.deepEqual(checked.result, {
      ready: false,
      platform: "linux",
      status: "dependencies_missing",
      problems: [
        "bubblewrap (bwrap) not installed",
        "seccomp not available\nmanual setup required",
      ],
    });
    assert.equal(installCalls, 0);
    assert.match(checked.stdout, /first interactive launch will offer guided setup/u);
    assert.match(checked.stdout, /seccomp not available manual setup required/u);
    assert.equal(checked.stderr, "");
  });

  it("returns unsupported without attempting setup", async () => {
    let installCalls = 0;
    const runtime = runtimeStub({
      supported: false,
      onInstall: () => { installCalls += 1; },
    });

    const checked = await runCheck("aix", async () => runtime);

    assert.deepEqual(checked.result, {
      ready: false,
      platform: "aix",
      status: "unsupported",
    });
    assert.equal(installCalls, 0);
    assert.match(checked.stdout, /does not support aix/u);
    assert.equal(checked.stderr, "");
  });

  it("contains runtime loader failures and lets npm installation continue", async () => {
    const checked = await runCheck("linux", async () => {
      throw new Error("fixture loader failed");
    });

    assert.deepEqual(checked.result, {
      ready: false,
      platform: "linux",
      status: "check_failed",
    });
    assert.equal(checked.stdout, "");
    assert.match(checked.stderr, /fixture loader failed/u);
    assert.match(checked.stderr, /Installation will continue/u);
  });
});
