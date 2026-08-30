import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, it } from "./harness.js";

interface InstallResult {
  skipped: boolean;
  reason?: string;
  installed: string[];
  failed: Array<{ program: string; detail: string }>;
}

interface InstallerModule {
  findVsCodeClis(options?: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    platform?: NodeJS.Platform;
  }): string[];
  isInside(candidate: string, root: string, platform?: NodeJS.Platform): boolean;
  installBundledVsCodeExtension(options?: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    platform?: NodeJS.Platform;
    programs?: string[];
    vsixPath?: string;
    spawnSync?: (...args: unknown[]) => {
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error;
    };
  }): InstallResult;
  safeInstallerEnvironment(
    source?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ): NodeJS.ProcessEnv;
}

interface PostinstallModule {
  runPostinstall(options?: {
    loadDatabase?: () => unknown;
    prepareModel?: () => Promise<{
      modelDirectory: string;
      manifest: { dimension: number; maxSequenceLength: number };
      downloaded: string[];
      reused: string[];
    }>;
    validateStack?: (model: unknown) => Promise<unknown>;
    installExtension?: () => InstallResult;
    stdout?: { write(message: string): unknown };
    stderr?: { write(message: string): unknown };
  }): Promise<{
    sqliteReady: boolean;
    modelReady: boolean;
    vectorStackReady: boolean;
    extensionResult?: InstallResult;
  }>;
}

interface VsixVerifierModule {
  verifyBundledVsix(options?: {
    packageRoot?: string;
    sourceRoot?: string;
    vsixPath?: string;
    manifestPath?: string;
  }): {
    extensionVersion: string;
    sourcesVerified: boolean;
    vsixPath: string;
  };
}

const require = createRequire(import.meta.url);
const installer = require(
  path.join(process.cwd(), "scripts", "install-vscode-extension.cjs"),
) as InstallerModule;
const postinstall = require(
  path.join(process.cwd(), "scripts", "postinstall.cjs"),
) as PostinstallModule;
const vsixVerifier = require(
  path.join(process.cwd(), "scripts", "verify-vscode-extension.cjs"),
) as VsixVerifierModule;

describe("VS Code extension installer", () => {
  it("recognizes descendants without treating siblings as inside", () => {
    const root = path.resolve("project");
    assert.equal(installer.isInside(path.join(root, "child", "file"), root), true);
    assert.equal(installer.isInside(path.resolve("project-other", "file"), root), false);
  });

  it("installs the bundled VSIX through only the preferred VS Code CLI", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-vscode-installer-"));
    try {
      const extensionDirectory = path.join(root, "vscode-extension");
      mkdirSync(extensionDirectory);
      const vsix = path.join(extensionDirectory, "easy-code-vscode.vsix");
      writeFileSync(vsix, "fixture");
      const calls: unknown[][] = [];
      const result = installer.installBundledVsCodeExtension({
        packageRoot: root,
        platform: "linux",
        programs: ["/usr/bin/code", "/usr/bin/codium"],
        spawnSync: (...args: unknown[]) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.skipped, false);
      assert.deepEqual(result.installed, ["/usr/bin/code"]);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.[1], ["--install-extension", vsix]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports an explicit opt-out for managed and CI installations", () => {
    const result = installer.installBundledVsCodeExtension({
      env: { EASY_CODE_SKIP_VSCODE_EXTENSION: "1" },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "disabled");
  });

  it("allows a user VS Code CLI below INIT_CWD but outside its npm shim directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-vscode-home-"));
    try {
      const home = path.join(root, "home");
      const cli = path.join(
        home,
        "Applications",
        process.platform === "win32" ? "code.cmd" : "code",
      );
      mkdirSync(path.dirname(cli), { recursive: true });
      writeFileSync(cli, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const programs = installer.findVsCodeClis({
        env: {
          EASY_CODE_VSCODE_CLI: cli,
          INIT_CWD: home,
        },
        packageRoot: path.join(root, "installed-package"),
        platform: process.platform,
      });
      assert.deepEqual(programs, [path.resolve(cli)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates symlink targets without replacing the executable launch path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-vscode-symlink-"));
    try {
      const realDirectory = path.join(root, "real");
      const linkDirectory = path.join(root, "launcher");
      const executableName = process.platform === "win32" ? "code.cmd" : "code";
      mkdirSync(realDirectory);
      writeFileSync(
        path.join(realDirectory, executableName),
        process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
        { mode: 0o700 },
      );
      symlinkSync(
        realDirectory,
        linkDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const launchPath = path.join(linkDirectory, executableName);
      const programs = installer.findVsCodeClis({
        env: { EASY_CODE_VSCODE_CLI: launchPath },
        packageRoot: path.join(root, "installed-package"),
        platform: process.platform,
      });
      assert.deepEqual(programs, [path.resolve(launchPath)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not forward provider secrets to the VS Code installer", () => {
    const environment = installer.safeInstallerEnvironment({
      HOME: "/home/tester",
      PATH: "/usr/bin",
      VSCODE_IPC_HOOK_CLI: "/tmp/vscode.sock",
      QWEN_API_KEY: "qwen-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
      ZAI_API_KEY: "glm-secret",
      GLM_API_KEY: "glm-alias-secret",
    }, "linux");
    assert.equal(environment.HOME, "/home/tester");
    assert.equal(environment.VSCODE_IPC_HOOK_CLI, "/tmp/vscode.sock");
    assert.equal(environment.QWEN_API_KEY, undefined);
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    assert.equal(environment.ZAI_API_KEY, undefined);
    assert.equal(environment.GLM_API_KEY, undefined);
  });

  it("rejects an explicit VS Code shim from the consuming workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-vscode-path-"));
    try {
      const consumer = path.join(root, "consumer");
      const shimDirectory = path.join(consumer, "node_modules", ".bin");
      mkdirSync(shimDirectory, { recursive: true });
      const shim = path.join(
        shimDirectory,
        process.platform === "win32" ? "code.cmd" : "code",
      );
      writeFileSync(shim, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const programs = installer.findVsCodeClis({
        env: {
          EASY_CODE_VSCODE_CLI: shim,
          INIT_CWD: consumer,
        },
        packageRoot: path.join(root, "installed-package"),
        platform: process.platform,
      });
      assert.deepEqual(programs, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not prepare the model or install the VS Code extension when SQLite validation fails", async () => {
    let modelPrepareCalled = false;
    let extensionInstallCalled = false;
    let stderr = "";
    const result = await postinstall.runPostinstall({
      loadDatabase: () => {
        throw new Error("sqlite fixture failed");
      },
      prepareModel: async () => {
        modelPrepareCalled = true;
        throw new Error("model preparation should not run");
      },
      installExtension: () => {
        extensionInstallCalled = true;
        return { skipped: false, installed: [], failed: [] };
      },
      stdout: { write: () => undefined },
      stderr: {
        write: (message) => {
          stderr += message;
        },
      },
    });
    assert.equal(result.sqliteReady, false);
    assert.equal(result.modelReady, false);
    assert.equal(result.vectorStackReady, false);
    assert.equal(modelPrepareCalled, false);
    assert.equal(extensionInstallCalled, false);
    assert.match(stderr, /sqlite fixture failed/u);
  });

  it("prepares and validates required memory dependencies before installing the extension", async () => {
    const order: string[] = [];
    let stdout = "";
    const result = await postinstall.runPostinstall({
      prepareModel: async () => {
        order.push("model");
        return {
          modelDirectory: path.join(tmpdir(), "embedding-model-fixture"),
          manifest: { dimension: 384, maxSequenceLength: 128 },
          downloaded: ["onnx/model_quantized.onnx"],
          reused: ["tokenizer.json"],
        };
      },
      validateStack: async () => {
        order.push("runtime");
      },
      installExtension: () => {
        order.push("extension");
        return { skipped: true, reason: "missing-vscode", installed: [], failed: [] };
      },
      stdout: {
        write: (message) => {
          stdout += message;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.deepEqual(order, ["model", "runtime", "extension"]);
    assert.equal(result.sqliteReady, true);
    assert.equal(result.modelReady, true);
    assert.equal(result.vectorStackReady, true);
    assert.match(stdout, /1 downloaded, 1 reused/u);
    assert.match(stdout, /vector search, tokenizer, and ONNX inference are ready/u);
  });

  it("fails required model/runtime checks without leaving a partial extension install", async () => {
    let validationCalled = false;
    let extensionInstallCalled = false;
    let stderr = "";
    const preparationFailure = await postinstall.runPostinstall({
      prepareModel: async () => {
        throw new Error("model fixture failed");
      },
      validateStack: async () => {
        validationCalled = true;
      },
      installExtension: () => {
        extensionInstallCalled = true;
        return { skipped: false, installed: [], failed: [] };
      },
      stdout: { write: () => undefined },
      stderr: { write: (message) => { stderr += message; } },
    });
    assert.equal(preparationFailure.modelReady, false);
    assert.equal(preparationFailure.vectorStackReady, false);
    assert.equal(validationCalled, false);
    assert.equal(extensionInstallCalled, false);
    assert.match(stderr, /model fixture failed/u);

    stderr = "";
    const runtimeFailure = await postinstall.runPostinstall({
      prepareModel: async () => ({
        modelDirectory: path.join(tmpdir(), "embedding-model-fixture"),
        manifest: { dimension: 384, maxSequenceLength: 128 },
        downloaded: [],
        reused: [],
      }),
      validateStack: async () => {
        throw new Error("runtime fixture failed");
      },
      installExtension: () => {
        extensionInstallCalled = true;
        return { skipped: false, installed: [], failed: [] };
      },
      stdout: { write: () => undefined },
      stderr: { write: (message) => { stderr += message; } },
    });
    assert.equal(runtimeFailure.modelReady, true);
    assert.equal(runtimeFailure.vectorStackReady, false);
    assert.equal(extensionInstallCalled, false);
    assert.match(stderr, /runtime fixture failed/u);
  });

  it("verifies that the bundled VSIX matches its generated manifest and sources", () => {
    const result = vsixVerifier.verifyBundledVsix({ packageRoot: process.cwd() });
    assert.equal(result.extensionVersion, "0.1.6");
    assert.equal(result.sourcesVerified, true);
  });

  it("rejects a bundled VSIX manifest after extension source changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-vsix-stale-"));
    try {
      const source = path.join(process.cwd(), "vscode-extension");
      const target = path.join(root, "vscode-extension");
      mkdirSync(path.join(target, "lib"), { recursive: true });
      for (const relative of [
        ".vscodeignore",
        "LICENSE",
        "README.md",
        "extension.js",
        "package.json",
        "easy-code-vscode.manifest.json",
        "easy-code-vscode.vsix",
        "lib/clipboard.js",
        "lib/command-detection.js",
      ]) {
        copyFileSync(
          path.join(source, ...relative.split("/")),
          path.join(target, ...relative.split("/")),
        );
      }
      const extensionPath = path.join(target, "extension.js");
      writeFileSync(
        extensionPath,
        `${readFileSync(extensionPath, "utf8")}\n// stale source fixture\n`,
        "utf8",
      );
      assert.throws(
        () => vsixVerifier.verifyBundledVsix({ packageRoot: root }),
        /source changed after packaging/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
