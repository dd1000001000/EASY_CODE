import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
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
  it("ships the merged LoRA ONNX and matching current evaluation without training dependencies", () => {
    const release = path.join(process.cwd(), "model-weights/laya-multilingual/joint-v2");
    const manifest = JSON.parse(fs.readFileSync(path.join(release, "model/onnx_manifest.json"), "utf8"));
    const training = JSON.parse(fs.readFileSync(path.join(release, "report.json"), "utf8"));
    const evaluation = JSON.parse(fs.readFileSync(path.join(release, "onnx-evaluation.json"), "utf8"));
    assert.equal(manifest.training.method, "lora");
    assert.equal(training.method, "lora");
    assert.equal(manifest.training.lora.rank, training.hyperparameters.lora_rank);
    assert.equal(manifest.training.lora.alpha, training.hyperparameters.lora_alpha);
    assert.equal(manifest.training.lora.dropout, training.hyperparameters.lora_dropout);
    assert.equal(manifest.training.epochs, training.selected_epochs);
    assert.equal(manifest.files["model.onnx"], evaluation.model_sha256);
    for (const task of ["route", "delivery"]) {
      assert.equal(evaluation.by_task[task].correct_orders, training.held_out_test.trained[task].correct_orders);
    }
    assert.equal(fs.existsSync(path.join(release, "model/model.safetensors")), false);
    assert.equal(fs.existsSync(path.join(release, "model/adapter_model.safetensors")), false);
  });
  it("fails before downloading dependencies when bundled model assets are missing", () => {
    let launched = false;
    assert.throws(() => prepareLaya({
      dataDir: path.resolve("fixture-easy-code-data"),
      workerPath: path.resolve("fixture-worker.py"),
      modelPath: path.resolve("missing-model.onnx"),
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
    const modelPath = path.resolve("fixture-model.onnx");
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
          JSON.stringify({ type: "ready", modelSha256: "test", device: "cpu", backend: "onnx-fp32" }),
          JSON.stringify({ type: "result", id: "install-smoke", decision: "CODE" }),
        ].join("\n") };
      },
    };
    const installed = prepareLaya(options);
    assert.equal(installed.reused, false);
    assert.equal(installed.runtime, path.join(dataDir, "runtimes", "laya-decision-onnx"));
    assert.ok(calls.some(call => call.some(arg => arg.startsWith("onnxruntime==")) && call.includes("tokenizers==0.23.2")));
    assert.ok(!calls.flat().some(arg => /^(torch|laya)==/u.test(arg)));
    const callCount = calls.length;
    const reused = prepareLaya(options);
    assert.equal(reused.reused, true);
    assert.equal(calls.length, callCount + 1);
  });
  it("selects a wheel-supported ONNX pin for Python 3.10", () => {
    const calls: string[][] = [];
    let installed = false;
    const workerPath = path.resolve("fixture-worker.py");
    const modelPath = path.resolve("fixture-model.onnx");
    prepareLaya({
      dataDir: path.resolve("fixture-easy-code-data"), workerPath, modelPath,
      python: { program: "bootstrap-python", prefix: [] },
      existsSync: target => target === workerPath || target === modelPath || target.endsWith(
        process.platform === "win32" ? "python.exe" : "python"),
      mkdirSync: () => undefined,
      run: (program, args) => {
        calls.push([program, ...args]);
        if (args.includes("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"))
          return { status: 0, stdout: "3.10\n", stderr: "" };
        if (args.includes("pip")) { installed = true; return { status: 0, stdout: "", stderr: "" }; }
        if (!installed) return { status: 1, stdout: "", stderr: "worker not yet installed" };
        return { status: 0, stderr: "", stdout: [
          JSON.stringify({ type: "ready", modelSha256: "test", device: "cpu", backend: "onnx-fp32" }),
          JSON.stringify({ type: "result", id: "install-smoke", decision: "CODE" }),
        ].join("\n") };
      },
    });
    assert.ok(calls.some(call => call.includes("onnxruntime==1.23.2")));
  });
});
