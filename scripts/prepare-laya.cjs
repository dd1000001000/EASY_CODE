"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { defaultDataDir, findPython } = require("./prepare-markitdown.cjs");

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    encoding: "utf8", windowsHide: true, input: options.input,
    timeout: options.timeout || VERIFY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio || "pipe",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", USE_TF: "0" },
  });
}

function resultDetail(result, fallback) {
  if (result.error) return result.error.message;
  return (result.stderr || result.stdout || fallback).trim().slice(-1500);
}

/**
 * Install the pinned inference stack into an EASY CODE-owned virtualenv.
 * A model-backed smoke test is required before treating a reused or newly
 * installed environment as ready. Partial installations are safely retried.
 */
function prepareLaya(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.EASY_CODE_DATA_DIR || defaultDataDir());
  const runtime = path.join(dataDir, "runtimes", "laya-decision");
  const python = process.platform === "win32"
    ? path.join(runtime, "Scripts", "python.exe")
    : path.join(runtime, "bin", "python");
  const worker = options.workerPath || path.join(__dirname, "..", "resources", "laya-decision", "worker.py");
  const modelFile = options.modelPath || path.join(__dirname, "..", "model-weights", "laya-multilingual",
    "joint-v2", "model", "model.safetensors");
  const invoke = options.run || run;
  const exists = options.existsSync || fs.existsSync;
  const makeDirectory = options.mkdirSync || fs.mkdirSync;
  if (!exists(worker) || !exists(modelFile))
    throw new Error("Bundled Laya worker or model weights are missing; reinstall the complete EASY CODE package.");
  const verify = () => {
    if (!exists(python) || !exists(worker)) return false;
    const checked = invoke(python, [worker], {
      input: JSON.stringify({ id: "install-smoke", task: "route", input: "Implement a small change and run its test." }) + "\n",
      timeout: VERIFY_TIMEOUT_MS,
    });
    if (checked.status !== 0) return false;
    try {
      const messages = checked.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
      return messages[0]?.type === "ready" &&
        messages[1]?.type === "result" &&
        ["DIRECT", "PLAN", "CODE"].includes(messages[1]?.decision);
    } catch { return false; }
  };

  if (verify()) return { runtime, python, reused: true };
  makeDirectory(path.dirname(runtime), { recursive: true, mode: 0o700 });
  if (!exists(python)) {
    const bootstrap = options.python || findPython();
    const created = invoke(bootstrap.program, [...bootstrap.prefix, "-m", "venv", runtime],
      { timeout: VERIFY_TIMEOUT_MS });
    if (created.status !== 0) throw new Error(`Laya virtualenv creation failed: ${resultDetail(created, "Python venv unavailable")}`);
  }
  const version = invoke(python, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
  const match = version.status === 0 ? /^(\d+)\.(\d+)$/u.exec(version.stdout.trim()) : null;
  if (!match) throw new Error(`Could not determine Laya Python version: ${resultDetail(version, "unknown version")}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 3 || minor < 10 || minor > 14)
    throw new Error(`Laya requires a tested Python 3.10–3.14 runtime; found ${major}.${minor}`);
  // PyTorch 2.8 has no CPython 3.14 wheels. Keep the tested 2.8 runtime on
  // earlier interpreters, and use the first wheel-supported pin on 3.14.
  const torchVersion = minor === 14 ? "2.9.0" : "2.8.0";
  const installed = invoke(python, ["-m", "pip", "install", "--disable-pip-version-check",
    "--no-input", "--only-binary=:all:", "laya==0.3.20", `torch==${torchVersion}`],
  { timeout: INSTALL_TIMEOUT_MS, stdio: "inherit" });
  if (installed.status !== 0) throw new Error(`Laya dependency installation failed: ${resultDetail(installed, "pip failed")}`);
  if (!verify()) throw new Error("Laya installation verification failed: the bundled model could not complete a local choice.");
  return { runtime, python, reused: false };
}

module.exports = { prepareLaya };

if (require.main === module) {
  try {
    const result = prepareLaya();
    process.stdout.write(`EASY CODE: local Laya decision runtime ready at ${result.runtime}.\n`);
  } catch (error) {
    process.stderr.write(`EASY CODE: local Laya setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
