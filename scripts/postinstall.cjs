"use strict";

const { installBundledVsCodeExtension } = require("./install-vscode-extension.cjs");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runPostinstall(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const loadDatabase = options.loadDatabase || (() => require("node-sqlite3-wasm"));
  const installExtension = options.installExtension || installBundledVsCodeExtension;

  let db;
  try {
    const { Database } = loadDatabase();
    db = new Database(":memory:");
    db.exec("CREATE TABLE easy_code_install_check (id INTEGER PRIMARY KEY)");
    db.exec("CREATE VIRTUAL TABLE easy_code_fts_check USING fts5(content)");
    db.close();
    db = undefined;
    stdout.write("EASY CODE: embedded SQLite WASM is ready.\n");
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // Preserve the original validation error.
      }
    }
    stderr.write(`EASY CODE: SQLite installation check failed: ${errorMessage(error)}\n`);
    // Do not install an editor extension for a CLI installation that npm will
    // reject. This keeps the postinstall operation from leaving partial state.
    return { sqliteReady: false, extensionResult: undefined };
  }

  try {
    const result = installExtension();
    if (result.installed.length) {
      stdout.write(
        `EASY CODE: installed the bundled VS Code extension into ${result.installed.length} installation(s).\n`,
      );
    } else if (result.reason === "missing-vscode") {
      stdout.write(
        "EASY CODE: VS Code was not found. Run `node scripts/install-vscode-extension.cjs` after installing VS Code.\n",
      );
    } else if (result.reason === "missing-vsix") {
      stderr.write(
        "EASY CODE: bundled VS Code extension was not found; CLI installation will continue.\n",
      );
    }
    for (const failure of result.failed) {
      stderr.write(
        `EASY CODE: could not install the VS Code extension via ${failure.program}: ${failure.detail}\n`,
      );
    }
    return { sqliteReady: true, extensionResult: result };
  } catch (error) {
    stderr.write(
      `EASY CODE: VS Code extension installation check failed: ${errorMessage(error)}\n`,
    );
    return { sqliteReady: true, extensionResult: undefined };
  }
}

module.exports = { runPostinstall };

if (require.main === module) {
  const result = runPostinstall();
  if (!result.sqliteReady) process.exitCode = 1;
}
