"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function defaultDataDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "easy-code", "Data");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "easy-code");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "easy-code");
}

function candidates() {
  if (process.env.EASY_CODE_BOOTSTRAP_PYTHON) return [[process.env.EASY_CODE_BOOTSTRAP_PYTHON, []]];
  return process.platform === "win32"
    ? [["py", ["-3"]], ["python", []]]
    : [["python3", []], ["python", []]];
}

function run(program, args, options = {}) {
  return spawnSync(program, args, { encoding: "utf8", windowsHide: true, stdio: options.stdio || "pipe" });
}

function findPython() {
  for (const [program, prefix] of candidates()) {
    const probe = run(program, [...prefix, "-c", "import sys; print(sys.version_info[:2] >= (3, 10))"]);
    if (probe.status === 0 && probe.stdout.trim() === "True") return { program, prefix };
  }
  throw new Error("Python 3.10 or newer is required for document conversion.");
}

function prepareMarkitdown(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.EASY_CODE_DATA_DIR || defaultDataDir());
  const runtime = path.join(dataDir, "runtimes", "markitdown");
  const python = process.platform === "win32" ? path.join(runtime, "Scripts", "python.exe") : path.join(runtime, "bin", "python");
  const bootstrap = options.python || findPython();
  fs.mkdirSync(path.dirname(runtime), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(python)) {
    const created = run(bootstrap.program, [...bootstrap.prefix, "-m", "venv", runtime]);
    if (created.status !== 0) throw new Error((created.stderr || created.stdout || "Unable to create the document converter runtime.").trim());
  }
  // No version pin intentionally: each install/reinstall resolves the newest stable release.
  const installed = run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "markitdown[all]"]);
  if (installed.status !== 0) throw new Error((installed.stderr || installed.stdout || "Unable to install MarkItDown.").trim());
  const verified = run(python, ["-c", "from markitdown import MarkItDown; print('ready')"]);
  if (verified.status !== 0 || verified.stdout.trim() !== "ready") throw new Error("MarkItDown installation verification failed.");
  return { runtime, python };
}

module.exports = { defaultDataDir, findPython, prepareMarkitdown };

if (require.main === module) {
  try {
    const result = prepareMarkitdown();
    process.stdout.write(`EASY CODE: document converter ready at ${result.runtime}.\n`);
  } catch (error) {
    process.stderr.write(`EASY CODE: document converter installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
