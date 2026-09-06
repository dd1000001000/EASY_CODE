"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PROVIDER_IDS = new Set(["deepseek", "qwen", "glm", "glm-coding-plan"]);
const PROVIDER_ADAPTERS = new Set(["deepseek", "qwen", "glm"]);
const VISION_SUPPORT = new Set(["supported", "unsupported", "unknown"]);
const THINKING_PROFILES = new Set([
  "unsupported",
  "qwen_budget",
  "deepseek_effort",
  "glm_forced_effort",
  "glm_optional_effort",
]);
const MODES = new Set(["auto", "plan", "code"]);
const THINKING_EFFORTS = new Set(["none", "low", "medium", "high"]);

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must contain an object`);
  const allowed = new Set(allowedKeys);
  const missing = allowedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(", ")}`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
}

function assertEnvironmentList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty ordered array`);
  }
  const observed = new Set();
  for (const [index, name] of value.entries()) {
    if (typeof name !== "string" || !ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error(`${label}[${index}] must be an uppercase environment variable name`);
    }
    if (observed.has(name)) throw new Error(`${label} contains duplicate ${name}`);
    observed.add(name);
  }
}

function validateHttpsBaseUrl(value, label) {
  assertNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value.endsWith("/")
  ) {
    throw new Error(`${label} must be an HTTPS base URL without credentials, query, fragment, or trailing slash`);
  }
}

function validateModelCatalog(value, relativePath = "models/catalog.json") {
  assertExactKeys(value, ["catalogVersion", "providers", "profiles"], relativePath);
  if (value.catalogVersion !== 1) throw new Error(`${relativePath}.catalogVersion must be 1`);
  if (!Array.isArray(value.providers) || value.providers.length !== PROVIDER_IDS.size) {
    throw new Error(`${relativePath}.providers must contain all four supported providers exactly once`);
  }

  const providers = new Map();
  for (const [providerIndex, provider] of value.providers.entries()) {
    const label = `${relativePath}.providers[${providerIndex}]`;
    assertExactKeys(
      provider,
      [
        "id",
        "label",
        "vendor",
        "adapter",
        "credentialSlot",
        "configKey",
        "defaultBaseUrl",
        "defaultModel",
        "environment",
        "models",
      ],
      label,
    );
    if (typeof provider.id !== "string" || !PROVIDER_ID_PATTERN.test(provider.id)) {
      throw new Error(`${label}.id must be a normalized provider identifier`);
    }
    if (!PROVIDER_IDS.has(provider.id)) throw new Error(`${label}.id is not a supported provider`);
    if (providers.has(provider.id)) throw new Error(`${relativePath}.providers contains duplicate ${provider.id}`);
    assertNonEmptyString(provider.label, `${label}.label`);
    assertNonEmptyString(provider.vendor, `${label}.vendor`);
    if (!PROVIDER_ADAPTERS.has(provider.adapter)) {
      throw new Error(`${label}.adapter must be qwen, deepseek, or glm`);
    }
    const requiredAdapter = provider.id === "glm-coding-plan" ? "glm" : provider.id;
    if (provider.adapter !== requiredAdapter) {
      throw new Error(`${label}.adapter must be ${requiredAdapter} for ${provider.id}`);
    }
    if (provider.credentialSlot !== provider.id) {
      throw new Error(`${label}.credentialSlot must be ${provider.id}`);
    }
    if (provider.configKey !== `${provider.id}.api-key`) {
      throw new Error(`${label}.configKey must be ${provider.id}.api-key`);
    }
    validateHttpsBaseUrl(provider.defaultBaseUrl, `${label}.defaultBaseUrl`);
    assertNonEmptyString(provider.defaultModel, `${label}.defaultModel`);

    assertExactKeys(
      provider.environment,
      ["apiKey", "baseUrl", "model", "timeoutMs", "maxRetries"],
      `${label}.environment`,
    );
    for (const key of ["apiKey", "baseUrl", "model", "timeoutMs", "maxRetries"]) {
      assertEnvironmentList(provider.environment[key], `${label}.environment.${key}`);
    }

    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      throw new Error(`${label}.models must be a non-empty array`);
    }
    const modelIds = new Set();
    const modelLabels = new Set();
    for (const [modelIndex, model] of provider.models.entries()) {
      const modelLabel = `${label}.models[${modelIndex}]`;
      assertExactKeys(model, ["id", "label", "vision", "thinking"], modelLabel);
      if (typeof model.id !== "string" || !MODEL_ID_PATTERN.test(model.id)) {
        throw new Error(`${modelLabel}.id must be a normalized model identifier`);
      }
      const normalizedId = model.id.toLowerCase();
      if (modelIds.has(normalizedId)) throw new Error(`${label}.models contains duplicate ${model.id}`);
      modelIds.add(normalizedId);
      assertNonEmptyString(model.label, `${modelLabel}.label`);
      const normalizedLabel = model.label.toLowerCase();
      if (modelLabels.has(normalizedLabel)) {
        throw new Error(`${label}.models contains duplicate label ${model.label}`);
      }
      modelLabels.add(normalizedLabel);
      if (!VISION_SUPPORT.has(model.vision)) {
        throw new Error(`${modelLabel}.vision has an unsupported capability value`);
      }
      if (!THINKING_PROFILES.has(model.thinking)) {
        throw new Error(`${modelLabel}.thinking has an unsupported profile value`);
      }
      if (provider.id === "glm-coding-plan" && model.vision !== "unsupported") {
        throw new Error(`${modelLabel}.vision must be unsupported for direct Coding Plan requests`);
      }
    }
    if (!modelIds.has(provider.defaultModel.toLowerCase())) {
      throw new Error(`${label}.defaultModel must reference a model in the same provider`);
    }
    providers.set(provider.id, provider);
  }

  for (const providerId of PROVIDER_IDS) {
    if (!providers.has(providerId)) throw new Error(`${relativePath}.providers is missing ${providerId}`);
  }
  for (const environmentKind of ["apiKey", "baseUrl", "model", "timeoutMs", "maxRetries"]) {
    const glmNames = new Set(providers.get("glm").environment[environmentKind]);
    const codingPlanNames = providers.get("glm-coding-plan").environment[environmentKind];
    const sharedName = codingPlanNames.find((name) => glmNames.has(name));
    if (sharedName) {
      throw new Error(
        `${relativePath} must keep standard GLM and GLM Coding Plan ${environmentKind} variables distinct (${sharedName})`,
      );
    }
  }

  assertExactKeys(value.profiles, ["sweBenchVerified50"], `${relativePath}.profiles`);
  const benchmark = value.profiles.sweBenchVerified50;
  assertExactKeys(
    benchmark,
    ["provider", "model", "mode", "thinkingEffort"],
    `${relativePath}.profiles.sweBenchVerified50`,
  );
  if (benchmark.provider !== "glm-coding-plan") {
    throw new Error(`${relativePath}.profiles.sweBenchVerified50.provider must be glm-coding-plan`);
  }
  const benchmarkProvider = providers.get(benchmark.provider);
  if (!benchmarkProvider.models.some((model) => model.id === benchmark.model)) {
    throw new Error(`${relativePath}.profiles.sweBenchVerified50.model must reference its provider catalog`);
  }
  if (!MODES.has(benchmark.mode)) {
    throw new Error(`${relativePath}.profiles.sweBenchVerified50.mode is unsupported`);
  }
  if (!THINKING_EFFORTS.has(benchmark.thinkingEffort)) {
    throw new Error(`${relativePath}.profiles.sweBenchVerified50.thinkingEffort is unsupported`);
  }
  return value;
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
  const modelCatalogPath = path.join(sourceDirectory, "models", "catalog.json");
  const config = readJson(configPath);
  const packageJson = readJson(packageJsonPath);
  const modelCatalogSource = fs.readFileSync(modelCatalogPath);
  const modelCatalog = validateModelCatalog(readJson(modelCatalogPath));
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
  const generatedModelCatalogPath = path.join(packageRoot, "src", "models", "generated-catalog.ts");
  const generatedContents = [
    "// Generated by scripts/build-prompt-bundle.cjs. Do not edit.",
    `export const EASY_CODE_RUNTIME_VERSION = ${JSON.stringify(packageJson.version)} as const;`,
    `export const PACKAGED_PROMPT_BUNDLE_VERSION = ${JSON.stringify(config.bundleVersion)} as const;`,
    `export const PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH = ${JSON.stringify(manifestHash)} as const;`,
    "",
  ].join("\n");
  const generatedModelCatalogContents = [
    "// Generated by scripts/build-prompt-bundle.cjs. Do not edit.",
    `export const PACKAGED_MODEL_CATALOG_SOURCE_HASH = ${JSON.stringify(sha256(modelCatalogSource))} as const;`,
    `export const PACKAGED_MODEL_CATALOG_CANONICAL_HASH = ${JSON.stringify(sha256(canonicalJson(modelCatalog)))} as const;`,
    "export const PACKAGED_MODEL_CATALOG =",
    `${JSON.stringify(modelCatalog, null, 2)} as const;`,
    "",
  ].join("\n");
  const manifestChanged = writeIfChanged(manifestPath, manifestContents);
  const generatedChanged = writeIfChanged(generatedPath, generatedContents);
  const generatedModelCatalogChanged = writeIfChanged(
    generatedModelCatalogPath,
    generatedModelCatalogContents,
  );
  return {
    bundleVersion: config.bundleVersion,
    fileCount: Object.keys(files).length,
    toolCount: Object.keys(tools).length,
    manifestHash,
    manifestPath,
    generatedPath,
    generatedModelCatalogPath,
    changed: manifestChanged || generatedChanged || generatedModelCatalogChanged,
  };
}

module.exports = {
  buildPromptBundle,
  canonicalJson,
  sha256,
  validateModelCatalog,
  validateToolMetadata,
};

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
