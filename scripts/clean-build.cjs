"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const allowedTargets = new Set(["dist", "dist-test"]);
const requested = process.argv.slice(2);

if (requested.length === 0) {
  throw new Error("Specify one generated build directory to clean");
}

for (const name of requested) {
  if (!allowedTargets.has(name)) {
    throw new Error(`Refusing to clean unsupported build directory: ${name}`);
  }
  const target = path.resolve(projectRoot, name);
  if (path.dirname(target) !== projectRoot || path.basename(target) !== name) {
    throw new Error(`Refusing to clean a path outside the project build roots: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
