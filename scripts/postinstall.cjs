"use strict";

try {
  const { Database } = require("node-sqlite3-wasm");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE easy_code_install_check (id INTEGER PRIMARY KEY)");
  db.exec("CREATE VIRTUAL TABLE easy_code_fts_check USING fts5(content)");
  db.close();
  process.stdout.write("EASY CODE: embedded SQLite WASM is ready.\n");
} catch (error) {
  process.stderr.write(`EASY CODE: SQLite installation check failed: ${error.message}\n`);
  process.exitCode = 1;
}
