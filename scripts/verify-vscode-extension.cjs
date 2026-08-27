"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_FILE = "easy-code-vscode.manifest.json";
const VSIX_FILE = "easy-code-vscode.vsix";
const BASE_SOURCE_FILES = [
  ".vscodeignore",
  "LICENSE",
  "README.md",
  "extension.js",
  "package.json",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(filename) {
  return sha256(fs.readFileSync(filename));
}

function hashTextFile(filename) {
  const text = fs.readFileSync(filename, "utf8")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
  return sha256(Buffer.from(text, "utf8"));
}

function collectFiles(directory, prefix = "") {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...collectFiles(absolute, relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

function collectSourceFiles(sourceRoot) {
  const files = [...BASE_SOURCE_FILES];
  const libraryRoot = path.join(sourceRoot, "lib");
  if (fs.existsSync(libraryRoot)) {
    files.push(...collectFiles(libraryRoot, "lib"));
  }
  return files.sort();
}

function readJson(filename, description) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${description} could not be read: ${detail}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must contain a JSON object.`);
  }
  return value;
}

function resolvePaths(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.join(__dirname, ".."));
  const sourceRoot = path.resolve(options.sourceRoot || path.join(packageRoot, "vscode-extension"));
  return {
    packageRoot,
    sourceRoot,
    vsixPath: path.resolve(options.vsixPath || path.join(sourceRoot, VSIX_FILE)),
    manifestPath: path.resolve(
      options.manifestPath || path.join(sourceRoot, MANIFEST_FILE),
    ),
  };
}

function createManifest(options = {}) {
  const paths = resolvePaths(options);
  const extensionPackage = readJson(
    path.join(paths.sourceRoot, "package.json"),
    "VS Code extension package.json",
  );
  if (typeof extensionPackage.version !== "string" || !extensionPackage.version) {
    throw new Error("VS Code extension package.json has no valid version.");
  }

  const vsix = fs.statSync(paths.vsixPath);
  if (!vsix.isFile()) throw new Error(`Bundled VSIX is not a file: ${paths.vsixPath}`);

  const sources = {};
  for (const relative of collectSourceFiles(paths.sourceRoot)) {
    const absolute = path.join(paths.sourceRoot, ...relative.split("/"));
    if (!fs.statSync(absolute).isFile()) {
      throw new Error(`VS Code extension source is not a file: ${relative}`);
    }
    sources[relative] = hashTextFile(absolute);
  }

  return {
    schemaVersion: 1,
    extensionVersion: extensionPackage.version,
    vsix: {
      file: VSIX_FILE,
      bytes: vsix.size,
      sha256: hashFile(paths.vsixPath),
    },
    sourceHashAlgorithm: "sha256-utf8-normalized-lf",
    sources,
  };
}

function writeManifest(options = {}) {
  const paths = resolvePaths(options);
  const manifest = createManifest(options);
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function verifyBundledVsix(options = {}) {
  const paths = resolvePaths(options);
  const manifest = readJson(paths.manifestPath, "Bundled VSIX manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported bundled VSIX manifest schema: ${manifest.schemaVersion}`);
  }
  if (
    !manifest.vsix ||
    manifest.vsix.file !== VSIX_FILE ||
    !Number.isSafeInteger(manifest.vsix.bytes) ||
    !/^[a-f0-9]{64}$/u.test(manifest.vsix.sha256 || "")
  ) {
    throw new Error("Bundled VSIX manifest has invalid artifact metadata.");
  }

  let stats;
  try {
    stats = fs.statSync(paths.vsixPath);
  } catch {
    throw new Error(`Bundled VSIX is missing: ${paths.vsixPath}`);
  }
  if (!stats.isFile()) throw new Error(`Bundled VSIX is not a file: ${paths.vsixPath}`);
  if (stats.size !== manifest.vsix.bytes || hashFile(paths.vsixPath) !== manifest.vsix.sha256) {
    throw new Error(
      "Bundled VSIX does not match its manifest. Run `npm run package:vscode` and commit both generated files.",
    );
  }

  const sourcesAvailable = fs.existsSync(path.join(paths.sourceRoot, "extension.js"));
  if (sourcesAvailable) {
    if (
      manifest.sourceHashAlgorithm !== "sha256-utf8-normalized-lf" ||
      !manifest.sources ||
      typeof manifest.sources !== "object" ||
      Array.isArray(manifest.sources)
    ) {
      throw new Error("Bundled VSIX manifest has invalid source metadata.");
    }
    const files = collectSourceFiles(paths.sourceRoot);
    const recordedFiles = Object.keys(manifest.sources).sort();
    if (files.join("\n") !== recordedFiles.join("\n")) {
      throw new Error(
        "VS Code extension source files changed after packaging. Run `npm run package:vscode`.",
      );
    }
    for (const relative of files) {
      const absolute = path.join(paths.sourceRoot, ...relative.split("/"));
      if (hashTextFile(absolute) !== manifest.sources[relative]) {
        throw new Error(
          `VS Code extension source changed after packaging: ${relative}. Run \`npm run package:vscode\`.`,
        );
      }
    }
    const extensionPackage = readJson(
      path.join(paths.sourceRoot, "package.json"),
      "VS Code extension package.json",
    );
    if (extensionPackage.version !== manifest.extensionVersion) {
      throw new Error("VS Code extension version does not match the bundled VSIX manifest.");
    }
  }

  return {
    extensionVersion: manifest.extensionVersion,
    sourcesVerified: sourcesAvailable,
    vsixPath: paths.vsixPath,
  };
}

module.exports = {
  MANIFEST_FILE,
  VSIX_FILE,
  createManifest,
  verifyBundledVsix,
  writeManifest,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--write")) writeManifest();
    const result = verifyBundledVsix();
    process.stdout.write(
      `EASY CODE: bundled VS Code extension ${result.extensionVersion} is current.\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`EASY CODE: VS Code extension verification failed: ${detail}\n`);
    process.exitCode = 1;
  }
}
