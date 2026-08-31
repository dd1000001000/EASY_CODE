import assert from "node:assert/strict";

import { Command } from "commander";

import {
  registerSandboxCommands,
  type SandboxReadiness,
  type SandboxSetupResult,
  type SandboxStartupService,
  type WindowsWorkspaceRepairPreview,
  type WindowsWorkspaceRepairService,
} from "../src/sandbox/index.js";
import { describe, it } from "./harness.js";

class StringOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

function readiness(
  status: SandboxReadiness["status"],
  canSetup = false,
): SandboxReadiness {
  return {
    status,
    platform: "linux",
    backend: "Sandbox CLI fixture",
    details: status === "ready" ? [] : ["fixture dependency is missing"],
    warnings: [],
    canSetup,
  };
}

async function runSandboxCommand(
  args: readonly string[],
  service: SandboxStartupService,
  workspaceRepairService?: WindowsWorkspaceRepairService,
): Promise<{ output: string; exitCodes: number[] }> {
  const output = new StringOutput();
  const exitCodes: number[] = [];
  const program = new Command()
    .name("easy-code")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.write(value),
      writeErr: (value) => output.write(value),
    });
  registerSandboxCommands(program, {
    service,
    workspaceRepairService,
    stdout: output,
    setExitCode: (code) => exitCodes.push(code),
  });
  await program.parseAsync(["node", "easy-code", ...args]);
  return { output: output.value, exitCodes };
}

function repairPreview(
  overrides: Partial<WindowsWorkspaceRepairPreview> = {},
): WindowsWorkspaceRepairPreview {
  return {
    target: "F:\\leetcode cph",
    currentOwner: "DESKTOP\\Developer",
    currentOwnerSid: "S-1-5-21-1-1001",
    scannedItems: 3,
    ownerRepairs: [{
      path: "F:\\leetcode cph\\.git",
      owner: "DESKTOP\\CodexSandboxOffline",
      inheritanceProtected: false,
      daclSddl: "D:(A;OICI;0x1301bf;;;AU)",
    }],
    skippedReparsePoints: [],
    inspectionErrors: [],
    ...overrides,
  };
}

function readyService(): SandboxStartupService {
  const ready = readiness("ready");
  return {
    inspect: async () => ready,
    setup: async () => ({
      status: "already_ready",
      message: "already ready",
      readiness: ready,
    }),
  };
}

describe("sandbox CLI commands", () => {
  it("prints a successful doctor report without setting a failure code", async () => {
    const ready = readiness("ready");
    const result = await runSandboxCommand(
      ["sandbox", "doctor"],
      {
        inspect: async () => ready,
        setup: async () => ({
          status: "already_ready",
          message: "already ready",
          readiness: ready,
        }),
      },
    );

    assert.match(result.output, /Sandbox backend: Sandbox CLI fixture/u);
    assert.match(result.output, /Filesystem and network sandbox checks passed/u);
    assert.deepEqual(result.exitCodes, []);
  });

  it("prints a failed doctor report and sets exit code 2", async () => {
    const missing = readiness("dependencies_missing", true);
    const result = await runSandboxCommand(
      ["sandbox", "doctor"],
      {
        inspect: async () => missing,
        setup: async () => ({
          status: "unavailable",
          message: "not used",
          readiness: missing,
        }),
      },
    );

    assert.match(result.output, /Required operating-system sandbox dependencies are missing/u);
    assert.match(result.output, /Detail: fixture dependency is missing/u);
    assert.deepEqual(result.exitCodes, [2]);
  });

  it("passes the inspected state to setup and reports verified success", async () => {
    const missing = readiness("dependencies_missing", true);
    const ready = readiness("ready");
    let setupInput: SandboxReadiness | undefined;
    const setupResult: SandboxSetupResult = {
      status: "completed",
      message: "Dependencies installed and verified.",
      readiness: ready,
    };
    const result = await runSandboxCommand(
      ["sandbox", "setup"],
      {
        inspect: async () => missing,
        setup: async (input) => {
          setupInput = input;
          return setupResult;
        },
      },
    );

    assert.equal(setupInput, missing);
    assert.match(result.output, /^Checking the command sandbox before setup/mu);
    assert.match(result.output, /Dependencies installed and verified/u);
    assert.match(result.output, /Filesystem and network sandbox checks passed/u);
    assert.deepEqual(result.exitCodes, []);
  });

  it("reports canceled setup and sets exit code 2 while readiness stays unready", async () => {
    const missing = readiness("setup_required", true);
    const result = await runSandboxCommand(
      ["sandbox", "setup"],
      {
        inspect: async () => missing,
        setup: async () => ({
          status: "cancelled",
          message: "Sandbox setup was canceled.",
          readiness: missing,
        }),
      },
    );

    assert.match(result.output, /Sandbox setup was canceled/u);
    assert.match(result.output, /One-time operating-system sandbox setup is required/u);
    assert.deepEqual(result.exitCodes, [2]);
  });

  it("dry-runs workspace ownership repair without applying changes", async () => {
    const preview = repairPreview();
    let applied = false;
    const result = await runSandboxCommand(
      ["sandbox", "repair-workspace", "--target", preview.target],
      readyService(),
      {
        inspect: async (target) => {
          assert.equal(target, preview.target);
          return preview;
        },
        apply: async () => {
          applied = true;
          throw new Error("not expected");
        },
      },
    );

    assert.equal(applied, false);
    assert.match(result.output, /CodexSandboxOffline-owned items: 1/u);
    assert.match(result.output, /Dry-run only; no owner or ACL was changed/u);
    assert.deepEqual(result.exitCodes, []);
  });

  it("requires an exact canonical confirmation before UAC repair", async () => {
    const preview = repairPreview();
    const repairService: WindowsWorkspaceRepairService = {
      inspect: async () => preview,
      apply: async () => {
        throw new Error("apply must not run");
      },
    };

    await assert.rejects(
      () => runSandboxCommand(
        [
          "sandbox",
          "repair-workspace",
          "--target",
          preview.target,
          "--apply",
          "--confirm",
          "F:\\somewhere else",
        ],
        readyService(),
        repairService,
      ),
      /Confirmation path does not match/u,
    );
  });

  it("applies the reviewed owner-only repair and verifies the result", async () => {
    const before = repairPreview();
    const after = repairPreview({ ownerRepairs: [] });
    let appliedPreview: WindowsWorkspaceRepairPreview | undefined;
    const result = await runSandboxCommand(
      [
        "sandbox",
        "repair-workspace",
        "--target",
        before.target,
        "--apply",
        "--confirm",
        before.target.toLowerCase(),
      ],
      readyService(),
      {
        inspect: async () => before,
        apply: async (preview) => {
          appliedPreview = preview;
          return {
            before,
            after,
            elevated: true,
            manifestPath: "C:\\Users\\Developer\\AppData\\Local\\easy-code\\sandbox-repair\\fixture.json",
          };
        },
      },
    );

    assert.equal(appliedPreview, before);
    assert.match(result.output, /Requesting Windows UAC elevation/u);
    assert.match(result.output, /Backup manifest:/u);
    assert.match(result.output, /Existing DACL and inheritance settings were preserved/u);
    assert.deepEqual(result.exitCodes, []);
  });
});
