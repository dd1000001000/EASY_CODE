import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

import {
  PROMPT_BUNDLE_FORMAT_VERSION,
  type PromptBundleManifest,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot canonicalize undefined Prompt Bundle data");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function computeManifestBundleHash(
  manifest: Omit<PromptBundleManifest, "bundleHash">,
): string {
  return sha256(canonicalJson(manifest));
}

export function computeToolSchemaHash(parameters: unknown): string {
  return sha256(canonicalJson(parameters));
}

export function computeFileHash(value: string | Buffer): string {
  return sha256(value);
}

function parseSemver(value: unknown, label: string): [number, number, number] {
  if (typeof value !== "string") throw new Error(`${label} must be a semantic version`);
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must use major.minor.patch without a prerelease`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty POSIX-style relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    path.posix.isAbsolute(value) ||
    value === "." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} escapes or is not normalized within the bundle`);
  }
}

export function parsePromptBundleManifest(value: unknown): PromptBundleManifest {
  if (!isRecord(value)) throw new Error("Prompt Bundle manifest must be an object");
  if (value.formatVersion !== PROMPT_BUNDLE_FORMAT_VERSION) {
    throw new Error(`Unsupported Prompt Bundle format version: ${String(value.formatVersion)}`);
  }
  parseSemver(value.bundleVersion, "bundleVersion");
  if (!isRecord(value.runtimeCompatibility)) {
    throw new Error("runtimeCompatibility must be an object");
  }
  const minimum = parseSemver(value.runtimeCompatibility.min, "runtimeCompatibility.min");
  const maximum = parseSemver(
    value.runtimeCompatibility.maxExclusive,
    "runtimeCompatibility.maxExclusive",
  );
  if (compareSemver(minimum, maximum) >= 0) {
    throw new Error("runtimeCompatibility.maxExclusive must be greater than min");
  }
  if (!isRecord(value.files)) throw new Error("files must be an object");

  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const [relativePath, rawEntry] of Object.entries(value.files)) {
    assertSafeRelativePath(relativePath, `files[${JSON.stringify(relativePath)}]`);
    if (relativePath === "manifest.json") {
      throw new Error("manifest.json must not list or hash itself");
    }
    if (!isRecord(rawEntry)) throw new Error(`Invalid file record for ${relativePath}`);
    if (typeof rawEntry.sha256 !== "string" || !SHA256_PATTERN.test(rawEntry.sha256)) {
      throw new Error(`Invalid SHA-256 for ${relativePath}`);
    }
    if (!Number.isSafeInteger(rawEntry.bytes) || Number(rawEntry.bytes) < 0) {
      throw new Error(`Invalid byte count for ${relativePath}`);
    }
    files[relativePath] = { sha256: rawEntry.sha256, bytes: Number(rawEntry.bytes) };
  }

  if (!isRecord(value.tools)) throw new Error("tools must be an object");
  const tools: Record<string, {
    path: string;
    contractVersion: string;
    contentHash: string;
    schemaHash?: string;
  }> = {};
  for (const [toolId, rawEntry] of Object.entries(value.tools)) {
    if (!TOOL_ID_PATTERN.test(toolId)) throw new Error(`Invalid tool id: ${toolId}`);
    if (!isRecord(rawEntry)) throw new Error(`Invalid tool record for ${toolId}`);
    assertSafeRelativePath(rawEntry.path, `tools.${toolId}.path`);
    if (rawEntry.path !== `tools/${toolId}.json`) {
      throw new Error(`Tool ${toolId} must use tools/${toolId}.json`);
    }
    parseSemver(rawEntry.contractVersion, `tools.${toolId}.contractVersion`);
    if (typeof rawEntry.contentHash !== "string" || !SHA256_PATTERN.test(rawEntry.contentHash)) {
      throw new Error(`Invalid content hash for tool ${toolId}`);
    }
    const file = files[rawEntry.path];
    if (!file || file.sha256 !== rawEntry.contentHash) {
      throw new Error(`Tool ${toolId} content hash does not match its bundled file`);
    }
    if (
      rawEntry.schemaHash !== undefined &&
      (typeof rawEntry.schemaHash !== "string" || !SHA256_PATTERN.test(rawEntry.schemaHash))
    ) {
      throw new Error(`Invalid schema hash for tool ${toolId}`);
    }
    tools[toolId] = {
      path: rawEntry.path,
      contractVersion: String(rawEntry.contractVersion),
      contentHash: rawEntry.contentHash,
      ...(rawEntry.schemaHash === undefined ? {} : { schemaHash: rawEntry.schemaHash }),
    };
  }
  if (typeof value.bundleHash !== "string" || !SHA256_PATTERN.test(value.bundleHash)) {
    throw new Error("bundleHash must be a SHA-256 value");
  }

  const manifestWithoutHash = {
    formatVersion: PROMPT_BUNDLE_FORMAT_VERSION,
    bundleVersion: String(value.bundleVersion),
    runtimeCompatibility: {
      min: String(value.runtimeCompatibility.min),
      maxExclusive: String(value.runtimeCompatibility.maxExclusive),
    },
    files,
    tools,
  } satisfies Omit<PromptBundleManifest, "bundleHash">;
  const expectedBundleHash = computeManifestBundleHash(manifestWithoutHash);
  if (value.bundleHash !== expectedBundleHash) {
    throw new Error("Prompt Bundle manifest bundleHash does not match its contents");
  }
  return deepFreeze({ ...manifestWithoutHash, bundleHash: value.bundleHash });
}

export function assertRuntimeCompatibility(
  manifest: PromptBundleManifest,
  runtimeVersion: string,
): void {
  const runtime = parseSemver(runtimeVersion, "runtimeVersion");
  const minimum = parseSemver(manifest.runtimeCompatibility.min, "runtimeCompatibility.min");
  const maximum = parseSemver(
    manifest.runtimeCompatibility.maxExclusive,
    "runtimeCompatibility.maxExclusive",
  );
  if (compareSemver(runtime, minimum) < 0 || compareSemver(runtime, maximum) >= 0) {
    throw new Error(
      `Prompt Bundle ${manifest.bundleVersion} is incompatible with EASY CODE ${runtimeVersion}`,
    );
  }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const current = prefix ? path.join(directory, ...prefix.split("/")) : directory;
  const entries = await readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, ...relative.split("/"));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Prompt Bundle contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) output.push(...await listFiles(directory, relative));
    else if (stat.isFile()) output.push(relative);
    else throw new Error(`Prompt Bundle contains an unsupported entry: ${relative}`);
  }
  return output.sort();
}

export async function verifyPromptBundleDirectory(
  directory: string,
  options: { expectedManifestHash?: string; runtimeVersion: string },
): Promise<{ manifest: PromptBundleManifest; manifestHash: string; manifestPath: string }> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Prompt Bundle root must be a real directory");
  }
  const manifestPath = path.join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Prompt Bundle manifest must be a regular file");
  }
  const rawManifest = await readFile(manifestPath);
  const manifestHash = computeFileHash(rawManifest);
  if (options.expectedManifestHash && manifestHash !== options.expectedManifestHash) {
    throw new Error("Prompt Bundle manifest does not match this EASY CODE build");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Prompt Bundle manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parsePromptBundleManifest(parsed);
  assertRuntimeCompatibility(manifest, options.runtimeVersion);

  const actualFiles = await listFiles(directory);
  const expectedFiles = ["manifest.json", ...Object.keys(manifest.files)].sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((item, i) => item !== expectedFiles[i])) {
    throw new Error("Prompt Bundle has missing or unlisted files");
  }
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    const absolute = path.join(directory, ...relativePath.split("/"));
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) {
      throw new Error(`Prompt Bundle file metadata mismatch: ${relativePath}`);
    }
    const value = await readFile(absolute);
    if (computeFileHash(value) !== expected.sha256) {
      throw new Error(`Prompt Bundle file hash mismatch: ${relativePath}`);
    }
  }
  return { manifest, manifestHash, manifestPath };
}

export function assertToolSchemaBinding(
  manifest: PromptBundleManifest,
  toolId: string,
  parameters: unknown,
): void {
  const entry = manifest.tools[toolId];
  if (!entry) throw new Error(`Prompt Bundle has no metadata for tool ${toolId}`);
  if (!entry.schemaHash) throw new Error(`Prompt Bundle tool ${toolId} has no bound schema hash`);
  if (entry.schemaHash !== computeToolSchemaHash(parameters)) {
    throw new Error(`Prompt Bundle tool ${toolId} schema does not match the compiled runtime`);
  }
}
