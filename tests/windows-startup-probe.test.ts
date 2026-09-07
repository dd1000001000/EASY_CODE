import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WindowsSandboxProcessLock } from "../src/sandbox/windows-process-lock.js";
import {
  createWindowsStartupProbePlan,
  runWindowsSandboxStartupProbe,
  WINDOWS_STARTUP_PROBE_TARGET_TIMEOUT_MS,
  type WindowsStartupProbeRuntime,
} from "../src/sandbox/windows-startup-probe.js";
import { describe, it } from "./harness.js";

const TRUSTED_CMD = "C:\\Windows\\System32\\cmd.exe";
const SRT_WIN = "C:\\easy-code\\srt-win.exe";

function successfulRuntime(events: string[] = []): WindowsStartupProbeRuntime {
  return {
    VENDORED_SRT_WIN_EXE: SRT_WIN,
    SandboxManager: {
      initialize: async () => {
        events.push("initialize");
      },
      wrapWithSandboxArgv: async (command, binShell) => {
        events.push(`wrap:${binShell ?? ""}:${command}`);
        return { argv: ["sandbox-broker.exe", "exec"], env: {} };
      },
      cleanupAfterCommand: () => {
        events.push("cleanup");
      },
      reset: async () => {
        events.push("reset");
      },
    },
  };
}

async function temporaryScratch(parent: string, name: string): Promise<string> {
  const scratch = path.join(parent, name);
  await mkdir(scratch);
  return scratch;
}

describe("Windows sandbox startup probe", () => {
  it("never grants a system Node installation or its Program Files directory", () => {
    const scratch = "C:\\Users\\tester\\AppData\\Local\\Temp\\easy-code-probe";
    const systemNode = "C:\\Program Files\\nodejs\\node.exe";
    const systemNodeDirectory = path.win32.dirname(systemNode).toLowerCase();
    const plan = createWindowsStartupProbePlan(scratch, TRUSTED_CMD, SRT_WIN);
    const filesystem = plan.config.filesystem;

    assert.deepEqual(filesystem.allowRead, []);
    assert.deepEqual(filesystem.allowWrite, [scratch]);
    assert.deepEqual(filesystem.denyWrite, [plan.protectedDirectory]);
    assert.equal(
      [...filesystem.allowRead, ...filesystem.allowWrite, ...filesystem.denyWrite]
        .some((candidate) => candidate.toLowerCase() === systemNodeDirectory),
      false,
    );
    assert.equal(JSON.stringify(plan).includes(systemNode), false);
    assert.equal(JSON.stringify(plan).includes(systemNodeDirectory), false);
    assert.equal(plan.binShell, TRUSTED_CMD);
    assert.equal(plan.command, "exit /b 0");
  });

  it("does not start the target and releases reset/lease state when initialize rolls back", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "easy-code-startup-probe-test-"));
    const scratch = await temporaryScratch(parent, "scratch");
    const events: string[] = [];
    let wrapCalls = 0;
    let targetCalls = 0;
    const runtime: WindowsStartupProbeRuntime = {
      VENDORED_SRT_WIN_EXE: SRT_WIN,
      SandboxManager: {
        initialize: async () => {
          events.push("initialize");
          throw new Error("srt-win acl grant exited 1: batch rolled back");
        },
        wrapWithSandboxArgv: async () => {
          wrapCalls += 1;
          return { argv: ["must-not-run.exe"], env: {} };
        },
        cleanupAfterCommand: () => {
          events.push("cleanup");
        },
        reset: async () => {
          events.push("reset");
        },
      },
    };
    const processLock = {
      acquire: async () => {
        events.push("lease-acquire");
        return async () => {
          events.push("lease-release");
        };
      },
    };

    try {
      await assert.rejects(
        runWindowsSandboxStartupProbe(runtime, {
          platform: "win32",
          trustedSystemShellPath: TRUSTED_CMD,
          processLock,
          createScratch: async () => scratch,
          runProcess: async () => {
            targetCalls += 1;
            return 0;
          },
        }),
        /acl grant exited 1: batch rolled back/iu,
      );
      assert.equal(wrapCalls, 0);
      assert.equal(targetCalls, 0);
      assert.deepEqual(events, ["lease-acquire", "initialize", "reset", "lease-release"]);
      await assert.rejects(
        access(scratch),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("cleans up and releases the shared lease when the sandboxed target times out", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "easy-code-startup-timeout-test-"));
    const scratch = await temporaryScratch(parent, "scratch");
    const events: string[] = [];
    const runtime = successfulRuntime(events);
    const processLock = {
      acquire: async () => {
        events.push("lease-acquire");
        return async () => {
          events.push("lease-release");
        };
      },
    };

    try {
      await assert.rejects(
        runWindowsSandboxStartupProbe(runtime, {
          platform: "win32",
          trustedSystemShellPath: TRUSTED_CMD,
          processLock,
          createScratch: async () => scratch,
          runProcess: async (_executable, _args, _cwd, _environment, timeoutMs) => {
            assert.equal(timeoutMs, WINDOWS_STARTUP_PROBE_TARGET_TIMEOUT_MS);
            throw new Error(`Sandboxed process probe timed out after ${String(timeoutMs)}ms`);
          },
        }),
        /process probe timed out/iu,
      );
      assert.deepEqual(events, [
        "lease-acquire",
        "initialize",
        `wrap:${TRUSTED_CMD}:exit /b 0`,
        "cleanup",
        "reset",
        "lease-release",
      ]);
      await assert.rejects(
        access(scratch),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("holds the shared ACL lease through reset before another probe initializes", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "easy-code-startup-lock-test-"));
    const lockPath = path.join(parent, "windows-acl.lock");
    const firstScratch = await temporaryScratch(parent, "first-scratch");
    const secondScratch = await temporaryScratch(parent, "second-scratch");
    const firstLock = new WindowsSandboxProcessLock(lockPath, {
      waitTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const secondLock = new WindowsSandboxProcessLock(lockPath, {
      waitTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const events: string[] = [];
    let enterFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    let continueFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    let secondInitialized = false;

    const firstRuntime = successfulRuntime(events);
    firstRuntime.SandboxManager.initialize = async () => {
      events.push("first-initialize");
      enterFirst();
      await firstMayContinue;
    };
    firstRuntime.SandboxManager.reset = async () => {
      events.push("first-reset");
    };
    const secondRuntime = successfulRuntime(events);
    secondRuntime.SandboxManager.initialize = async () => {
      secondInitialized = true;
      events.push("second-initialize");
    };

    try {
      const first = runWindowsSandboxStartupProbe(firstRuntime, {
        platform: "win32",
        trustedSystemShellPath: TRUSTED_CMD,
        processLock: firstLock,
        createScratch: async () => firstScratch,
        runProcess: async () => 0,
      });
      await firstEntered;
      const second = runWindowsSandboxStartupProbe(secondRuntime, {
        platform: "win32",
        trustedSystemShellPath: TRUSTED_CMD,
        processLock: secondLock,
        createScratch: async () => secondScratch,
        runProcess: async () => 0,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(secondInitialized, false);
      continueFirst();
      await Promise.all([first, second]);
      assert.equal(secondInitialized, true);
      assert.ok(events.indexOf("first-reset") < events.indexOf("second-initialize"));
    } finally {
      continueFirst();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
