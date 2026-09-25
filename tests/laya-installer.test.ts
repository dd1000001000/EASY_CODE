import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "./harness.js";

const require = createRequire(import.meta.url);
const { prepareLaya } = require(path.join(process.cwd(), "scripts", "prepare-laya.cjs")) as {
  prepareLaya(options: {
    dataDir: string;
    workerPath: string;
    modelPath: string;
    python: { program: string; prefix: string[] };
    existsSync: (target: string) => boolean;
    mkdirSync: () => void;
    run: (program: string, args: string[], options?: { input?: string }) => {
      status: number; stdout: string; stderr: string;
    };
  }): { runtime: string; python: string; reused: boolean };
};

describe("local Laya installation", () => {
  it("fails before downloading dependencies when bundled model assets are missing", () => {
    let launched = false;
    assert.throws(() => prepareLaya({
      dataDir: path.resolve("fixture-easy-code-data"),
      workerPath: path.resolve("fixture-worker.py"),
      modelPath: path.resolve("missing-model.safetensors"),
      python: { program: "bootstrap-python", prefix: [] },
      existsSync: target => target.endsWith("fixture-worker.py"),
      mkdirSync: () => undefined,
      run: () => { launched = true; return { status: 0, stdout: "", stderr: "" }; },
    }), /model weights are missing/u);
    assert.equal(launched, false);
  });
  it("creates a private runtime, installs pinned dependencies, verifies a decision and reuses it", () => {
    const dataDir = path.resolve("fixture-easy-code-data");
    const workerPath = path.resolve("fixture-worker.py");
    const modelPath = path.resolve("fixture-model.safetensors");
    let pythonExists = false;
    const calls: string[][] = [];
    const options = {
      dataDir, workerPath, modelPath, python: { program: "bootstrap-python", prefix: [] },
      existsSync: (target: string) => target === workerPath || target === modelPath || (pythonExists && target.endsWith(
        process.platform === "win32" ? "python.exe" : "python")),
      mkdirSync: () => undefined,
      run: (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (args.includes("venv")) { pythonExists = true; return { status: 0, stdout: "", stderr: "" }; }
        if (args.includes("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"))
          return { status: 0, stdout: "3.11\n", stderr: "" };
        if (args.includes("pip")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stderr: "", stdout: [
          JSON.stringify({ type: "ready", modelSha256: "test", device: "cpu" }),
          JSON.stringify({ type: "result", id: "install-smoke", decision: "CODE" }),
        ].join("\n") };
      },
    };
    const installed = prepareLaya(options);
    assert.equal(installed.reused, false);
    assert.equal(installed.runtime, path.join(dataDir, "runtimes", "laya-decision"));
    assert.ok(calls.some(call => call.includes("laya==0.3.20") && call.includes("torch==2.8.0")));
    const callCount = calls.length;
    const reused = prepareLaya(options);
    assert.equal(reused.reused, true);
    assert.equal(calls.length, callCount + 1);
  });
  it("selects a wheel-supported PyTorch pin for Python 3.14", () => {
    const calls: string[][] = [];
    let installed = false;
    const workerPath = path.resolve("fixture-worker.py");
    const modelPath = path.resolve("fixture-model.safetensors");
    prepareLaya({
      dataDir: path.resolve("fixture-easy-code-data"), workerPath, modelPath,
      python: { program: "bootstrap-python", prefix: [] },
      existsSync: target => target === workerPath || target === modelPath || target.endsWith(
        process.platform === "win32" ? "python.exe" : "python"),
      mkdirSync: () => undefined,
      run: (program, args) => {
        calls.push([program, ...args]);
        if (args.includes("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"))
          return { status: 0, stdout: "3.14\n", stderr: "" };
        if (args.includes("pip")) { installed = true; return { status: 0, stdout: "", stderr: "" }; }
        if (!installed) return { status: 1, stdout: "", stderr: "worker not yet installed" };
        return { status: 0, stderr: "", stdout: [
          JSON.stringify({ type: "ready", modelSha256: "test", device: "cpu" }),
          JSON.stringify({ type: "result", id: "install-smoke", decision: "CODE" }),
        ].join("\n") };
      },
    });
    assert.ok(calls.some(call => call.includes("torch==2.9.0")));
  });
});
