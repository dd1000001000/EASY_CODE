"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot canonicalize undefined Prompt Bundle data");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSemver(value, label) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must use major.minor.patch without a prerelease`);
  }
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function listFiles(root, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, ...prefix.split("/").filter(Boolean)), {
    withFileTypes: true,
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Prompt Bundle source contains a symlink: ${relative}`);
    if (stat.isDirectory()) result.push(...listFiles(root, relative));
    else if (stat.isFile() && relative !== "manifest.json") result.push(relative);
    else if (!stat.isFile()) throw new Error(`Unsupported Prompt Bundle entry: ${relative}`);
  }
  return result.sort();
}

function validateToolMetadata(toolId, value, relativePath) {
  if (!TOOL_ID_PATTERN.test(toolId)) throw new Error(`Invalid tool id in ${relativePath}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain an object`);
  }
  if (value.id !== toolId) throw new Error(`${relativePath} id must equal ${toolId}`);
  assertSemver(value.contractVersion, `${relativePath}.contractVersion`);
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    throw new Error(`${relativePath}.description must be non-empty`);
  }
  const guidanceIsValid =
    (typeof value.guidance === "string" && value.guidance.trim().length > 0) ||
    (Array.isArray(value.guidance) &&
      value.guidance.length > 0 &&
      value.guidance.every((item) => typeof item === "string" && item.trim().length > 0));
  if (!guidanceIsValid) throw new Error(`${relativePath}.guidance must be non-empty text`);
  if (
    !value.propertyDescriptions ||
    typeof value.propertyDescriptions !== "object" ||
    Array.isArray(value.propertyDescriptions) ||
    Object.values(value.propertyDescriptions).some(
      (item) => typeof item !== "string" || item.trim().length === 0,
    )
  ) {
    throw new Error(`${relativePath}.propertyDescriptions must map fields to non-empty text`);
  }
  const allowed = new Set([
    "id",
    "contractVersion",
    "description",
    "propertyDescriptions",
    "guidance",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${relativePath} contains unsupported fields: ${unknown.join(", ")}`);
}

function writeIfChanged(filename, contents) {
  if (fs.existsSync(filename) && fs.readFileSync(filename, "utf8") === contents) return false;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
  return true;
}

function buildPromptBundle(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.join(__dirname, ".."));
  const sourceDirectory = path.resolve(
    options.sourceDirectory || path.join(packageRoot, "resources", "prompt-bundle"),
  );
  const configPath = path.resolve(
    options.configPath || path.join(packageRoot, "resources", "prompt-bundle.config.json"),
  );
  const packageJsonPath = path.join(packageRoot, "package.json");
  const config = readJson(configPath);
  const packageJson = readJson(packageJsonPath);
  if (config.formatVersion !== 1) throw new Error("Prompt Bundle formatVersion must be 1");
  assertSemver(config.bundleVersion, "bundleVersion");
  if (!config.runtimeCompatibility || typeof config.runtimeCompatibility !== "object") {
    throw new Error("runtimeCompatibility must be configured");
  }
  assertSemver(config.runtimeCompatibility.min, "runtimeCompatibility.min");
  assertSemver(config.runtimeCompatibility.maxExclusive, "runtimeCompatibility.maxExclusive");
  assertSemver(packageJson.version, "package.version");
  if (
    compareSemver(config.runtimeCompatibility.min, config.runtimeCompatibility.maxExclusive) >= 0
  ) {
    throw new Error("runtimeCompatibility.maxExclusive must be greater than min");
  }
  if (
    compareSemver(packageJson.version, config.runtimeCompatibility.min) < 0 ||
    compareSemver(packageJson.version, config.runtimeCompatibility.maxExclusive) >= 0
  ) {
    throw new Error("The package version is outside the Prompt Bundle runtime compatibility range");
  }

  const files = {};
  const tools = {};
  for (const relativePath of listFiles(sourceDirectory)) {
    const absolute = path.join(sourceDirectory, ...relativePath.split("/"));
    const contents = fs.readFileSync(absolute);
    files[relativePath] = { sha256: sha256(contents), bytes: contents.length };
    const toolMatch = /^tools\/([a-z][a-z0-9_]{0,63})\.json$/u.exec(relativePath);
    if (toolMatch) {
      const toolId = toolMatch[1];
      const metadata = readJson(absolute);
      validateToolMetadata(toolId, metadata, relativePath);
      tools[toolId] = {
        path: relativePath,
        contractVersion: metadata.contractVersion,
        contentHash: files[relativePath].sha256,
      };
    }
  }

  const unsignedManifest = {
    formatVersion: 1,
    bundleVersion: config.bundleVersion,
    runtimeCompatibility: {
      min: config.runtimeCompatibility.min,
      maxExclusive: config.runtimeCompatibility.maxExclusive,
    },
    files,
    tools,
  };
  const manifest = { ...unsignedManifest, bundleHash: sha256(canonicalJson(unsignedManifest)) };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = sha256(manifestContents);
  const manifestPath = path.join(sourceDirectory, "manifest.json");
  const generatedPath = path.join(packageRoot, "src", "prompt-bundle", "generated.ts");
  const generatedContents = [
    "// Generated by scripts/build-prompt-bundle.cjs. Do not edit.",
    `export const EASY_CODE_RUNTIME_VERSION = ${JSON.stringify(packageJson.version)} as const;`,
    `export const PACKAGED_PROMPT_BUNDLE_VERSION = ${JSON.stringify(config.bundleVersion)} as const;`,
    `export const PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH = ${JSON.stringify(manifestHash)} as const;`,
    "",
  ].join("\n");
  const manifestChanged = writeIfChanged(manifestPath, manifestContents);
  const generatedChanged = writeIfChanged(generatedPath, generatedContents);
  return {
    bundleVersion: config.bundleVersion,
    fileCount: Object.keys(files).length,
    toolCount: Object.keys(tools).length,
    manifestHash,
    manifestPath,
    generatedPath,
    changed: manifestChanged || generatedChanged,
  };
}

module.exports = { buildPromptBundle, canonicalJson, sha256, validateToolMetadata };

if (require.main === module) {
  try {
    const result = buildPromptBundle();
    process.stdout.write(
      `EASY CODE: Prompt Bundle ${result.bundleVersion} ready ` +
      `(${result.fileCount} files, ${result.toolCount} tools).\n`,
    );
  } catch (error) {
    process.stderr.write(
      `EASY CODE: Prompt Bundle build failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
