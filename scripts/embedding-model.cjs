"use strict";

const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { URL } = require("node:url");

const MANIFEST_FILE = "manifest.json";
const MODEL_DIRECTORY = "paraphrase-multilingual-MiniLM-L12-v2";
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const DOWNLOAD_DEADLINE_MS = 30 * 60_000;
const MAX_REDIRECTS = 8;
const ATOMIC_REPLACE_RETRIES = 80;
const ATOMIC_REPLACE_RETRY_MS = 25;
const MODEL_INSTALL_LOCK_SUFFIX = ".easy-code-model-install-lock";
const MODEL_INSTALL_LOCK_OWNER_FILE = "owner.json";
const MODEL_INSTALL_LOCK_TIMEOUT_MS = 45 * 60_000;
const MODEL_INSTALL_LOCK_RETRY_MS = 25;

const EMBEDDING_MODEL_MANIFEST = deepFreeze({
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
  dimension: 384,
  maxSequenceLength: 128,
  pooling: "masked-mean",
  normalized: true,
  files: [
    {
      path: "config.json",
      size: 673,
      sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
    },
    {
      path: "special_tokens_map.json",
      size: 280,
      sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    },
    {
      path: "tokenizer.json",
      size: 17_082_913,
      sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
    },
    {
      path: "tokenizer_config.json",
      size: 496,
      sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 118_308_126,
      sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
    },
  ],
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isFileSystemError(error, code) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code,
  );
}

function isReplaceContention(error) {
  return ["EACCES", "EBUSY", "EEXIST", "ENOENT", "EPERM"].some((code) =>
    isFileSystemError(error, code),
  );
}

function wait(milliseconds, options = {}) {
  const pause = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  return pause(milliseconds);
}

function currentTime(options = {}) {
  const now = options.now || Date.now;
  return Number(now());
}

function positiveDuration(value, fallback, label) {
  const duration = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return Math.trunc(duration);
}

function downloadDeadline(options = {}) {
  if (options.deadlineAt !== undefined) {
    const deadline = Number(options.deadlineAt);
    if (!Number.isFinite(deadline)) throw new Error("deadlineAt must be finite");
    return deadline;
  }
  return currentTime(options) + positiveDuration(
    options.deadlineMs,
    DOWNLOAD_DEADLINE_MS,
    "deadlineMs",
  );
}

function remainingDownloadTime(deadlineAt, options = {}) {
  const remaining = Math.trunc(deadlineAt - currentTime(options));
  if (remaining <= 0) throw new Error("Embedding model download exceeded its absolute deadline");
  return remaining;
}

function discardHttpsResponse(response) {
  if (response && typeof response.destroy === "function") response.destroy();
  else if (response && typeof response.resume === "function") response.resume();
}

async function unlinkBestEffort(filePath, options = {}) {
  const fsp = options.fsp || fs.promises;
  for (let attempt = 0; attempt < ATOMIC_REPLACE_RETRIES; attempt += 1) {
    try {
      await fsp.unlink(filePath);
      return;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      if (!isReplaceContention(error) || attempt === ATOMIC_REPLACE_RETRIES - 1) return;
      await wait(ATOMIC_REPLACE_RETRY_MS, options);
    }
  }
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Embedding model manifest must be an object");
  }
  if (typeof manifest.model !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(manifest.model)) {
    throw new Error("Embedding model manifest has an invalid model ID");
  }
  if (typeof manifest.revision !== "string" || !/^[a-f0-9]{40}$/u.test(manifest.revision)) {
    throw new Error("Embedding model manifest must pin a full 40-character revision");
  }
  if (!Number.isInteger(manifest.dimension) || manifest.dimension <= 0) {
    throw new Error("Embedding model manifest has an invalid dimension");
  }
  if (!Number.isInteger(manifest.maxSequenceLength) || manifest.maxSequenceLength <= 0) {
    throw new Error("Embedding model manifest has an invalid maximum sequence length");
  }
  if (manifest.pooling !== "masked-mean" || manifest.normalized !== true) {
    throw new Error("Embedding model manifest has unsupported pooling metadata");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Embedding model manifest must contain files");
  }

  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object") {
      throw new Error("Embedding model manifest contains an invalid file entry");
    }
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.includes("\0") ||
      path.posix.isAbsolute(file.path) ||
      path.win32.isAbsolute(file.path) ||
      file.path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Embedding model manifest contains an unsafe path: ${String(file.path)}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Embedding model manifest contains a duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Embedding model manifest has an invalid size for ${file.path}`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error(`Embedding model manifest has an invalid SHA256 for ${file.path}`);
    }
  }
  return manifest;
}

function manifestDocument(manifest = EMBEDDING_MODEL_MANIFEST) {
  assertManifest(manifest);
  return {
    model: manifest.model,
    revision: manifest.revision,
    dimension: manifest.dimension,
    maxSequenceLength: manifest.maxSequenceLength,
    pooling: manifest.pooling,
    normalized: manifest.normalized,
    files: manifest.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

function serializedManifest(manifest = EMBEDDING_MODEL_MANIFEST) {
  return `${JSON.stringify(manifestDocument(manifest), null, 2)}\n`;
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Embedding model path escapes its cache directory: ${relativePath}`);
  }
  return target;
}

async function resolveEmbeddingModelDirectory(options = {}) {
  if (options.modelDirectory !== undefined) {
    if (typeof options.modelDirectory !== "string" || !options.modelDirectory.trim()) {
      throw new Error("modelDirectory must be a non-empty path");
    }
    return path.resolve(options.modelDirectory);
  }

  let cacheDirectory = options.cacheDirectory;
  if (cacheDirectory === undefined) {
    const loadEnvPaths = options.loadEnvPaths || (() => import("env-paths"));
    const imported = await loadEnvPaths();
    const envPaths = imported && typeof imported === "object" && "default" in imported
      ? imported.default
      : imported;
    if (typeof envPaths !== "function") {
      throw new Error("env-paths did not provide its path resolver");
    }
    const resolved = envPaths(options.appName || "easy-code", { suffix: "" });
    cacheDirectory = resolved && resolved.cache;
  }
  if (typeof cacheDirectory !== "string" || !cacheDirectory.trim()) {
    throw new Error("Embedding model cache directory could not be resolved");
  }
  return path.resolve(cacheDirectory, "models", MODEL_DIRECTORY);
}

function modelFileUrl(manifest, file) {
  assertManifest(manifest);
  const encodedModel = manifest.model.split("/").map(encodeURIComponent).join("/");
  const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${encodedModel}/resolve/${manifest.revision}/${encodedPath}`;
}

async function hashFile(filePath, options = {}) {
  const fsp = options.fsp || fs.promises;
  const createReadStream = options.createReadStream || fs.createReadStream;
  const makeHash = options.createHash || createHash;
  const metadata = await fsp.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Embedding model asset is not a regular file: ${filePath}`);
  }
  const digest = makeHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    digest.update(buffer);
  }
  return { size, sha256: digest.digest("hex") };
}

async function verifyAsset(modelDirectory, file, options = {}) {
  const filePath = resolveInside(modelDirectory, file.path);
  let actual;
  try {
    actual = await hashFile(filePath, options);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new Error(`Embedding model asset is missing: ${file.path}`);
    }
    throw error;
  }
  if (actual.size !== file.size) {
    throw new Error(
      `Embedding model asset ${file.path} has size ${actual.size}; expected ${file.size}`,
    );
  }
  if (actual.sha256 !== file.sha256) {
    throw new Error(`Embedding model asset ${file.path} failed SHA256 verification`);
  }
  return { path: filePath, size: actual.size, sha256: actual.sha256 };
}

async function verifyModelAssets(modelDirectory, manifest, options = {}) {
  const files = [];
  for (const file of manifest.files) {
    files.push(await verifyAsset(modelDirectory, file, options));
  }
  return files;
}

async function verifyEmbeddingModel(options = {}) {
  const manifest = assertManifest(options.manifest || EMBEDDING_MODEL_MANIFEST);
  const modelDirectory = await resolveEmbeddingModelDirectory(options);
  const files = await verifyModelAssets(modelDirectory, manifest, options);
  const manifestPath = path.join(modelDirectory, MANIFEST_FILE);
  let storedManifest;
  try {
    const metadata = await (options.fsp || fs.promises).lstat(manifestPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Embedding model manifest is not a regular file: ${manifestPath}`);
    }
    storedManifest = await (options.fsp || fs.promises).readFile(manifestPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new Error(`Embedding model manifest is missing: ${manifestPath}`);
    }
    throw error;
  }
  if (storedManifest !== serializedManifest(manifest)) {
    throw new Error("Embedding model manifest does not match the installed model revision");
  }
  return {
    modelDirectory,
    manifestPath,
    manifest: manifestDocument(manifest),
    files,
  };
}

async function requestHttpsResponse(source, options = {}) {
  const get = options.httpsGet || https.get;
  const idleTimeoutMs = positiveDuration(
    options.idleTimeoutMs ?? options.timeoutMs,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    "idleTimeoutMs",
  );
  const deadlineAt = downloadDeadline(options);
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  let current = new URL(source);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:") {
      throw new Error(`Refusing non-HTTPS embedding model URL: ${current.href}`);
    }
    const remaining = remainingDownloadTime(deadlineAt, options);
    const response = await new Promise((resolve, reject) => {
      let request;
      let deadlineTimer;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) cancelTimeout(deadlineTimer);
        callback(value);
      };
      const fail = (error) => finish(reject, error);
      try {
        request = get(
          current,
          {
            headers: {
              Accept: "application/octet-stream",
              "User-Agent": "easy-code-agent embedding-model installer",
            },
          },
          (incoming) => finish(resolve, incoming),
        );
      } catch (error) {
        fail(error);
        return;
      }
      if (request && typeof request.once === "function") request.once("error", fail);
      if (!settled) {
        deadlineTimer = scheduleTimeout(() => {
          const error = new Error("Embedding model download exceeded its absolute deadline");
          if (request && typeof request.destroy === "function") request.destroy(error);
          fail(error);
        }, remaining);
      }
      if (!settled && request && typeof request.setTimeout === "function") {
        request.setTimeout(idleTimeoutMs, () => {
          const error = new Error(
            `Embedding model download was idle for ${idleTimeoutMs}ms`,
          );
          if (typeof request.destroy === "function") request.destroy(error);
          fail(error);
        });
      }
    });
    const status = Number(response.statusCode || 0);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers && response.headers.location;
      discardHttpsResponse(response);
      if (!location) throw new Error(`Embedding model redirect from ${current.href} has no location`);
      current = new URL(location, current);
      continue;
    }
    if (status !== 200) {
      discardHttpsResponse(response);
      throw new Error(`Embedding model download failed with HTTP ${status} for ${current.href}`);
    }
    return response;
  }
  throw new Error(`Embedding model download exceeded ${MAX_REDIRECTS} redirects`);
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!result || result.bytesWritten <= 0) {
      throw new Error("Embedding model download could not make progress while writing");
    }
    offset += result.bytesWritten;
  }
}

async function atomicReplace(stagingPath, destinationPath, options = {}) {
  const fsp = options.fsp || fs.promises;
  let lastContention;
  for (let attempt = 0; attempt < ATOMIC_REPLACE_RETRIES; attempt += 1) {
    try {
      await fsp.rename(stagingPath, destinationPath);
      return;
    } catch (error) {
      if (!isReplaceContention(error)) throw error;
      lastContention = error;
    }

    const backupPath = `${destinationPath}.replaced-${process.pid}-${randomToken(options)}`;
    try {
      await fsp.rename(destinationPath, backupPath);
    } catch (error) {
      if (!isReplaceContention(error)) throw error;
      lastContention = error;
      await wait(ATOMIC_REPLACE_RETRY_MS, options);
      continue;
    }

    try {
      await fsp.rename(stagingPath, destinationPath);
      await unlinkBestEffort(backupPath, options);
      return;
    } catch (installError) {
      let destinationExists = false;
      try {
        const metadata = await fsp.lstat(destinationPath);
        destinationExists = metadata.isFile() && !metadata.isSymbolicLink();
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) {
          try {
            await fsp.rename(backupPath, destinationPath);
          } catch {
            // Report the original inspection failure below.
          }
          throw error;
        }
      }

      if (destinationExists && isReplaceContention(installError)) {
        // Another installer won the same pinned-file race. Its caller verifies
        // the final size and digest before the model is declared ready.
        await unlinkBestEffort(backupPath, options);
        return;
      }

      try {
        await fsp.rename(backupPath, destinationPath);
      } catch (restoreError) {
        throw new AggregateError(
          [installError, restoreError],
          `Could not install or restore embedding model asset ${destinationPath}`,
        );
      }
      if (!isReplaceContention(installError)) throw installError;
      lastContention = installError;
      await wait(ATOMIC_REPLACE_RETRY_MS, options);
    }
  }
  const error = new Error(
    `Embedding model asset remained busy while replacing ${destinationPath}`,
  );
  error.cause = lastContention;
  throw error;
}

function randomToken(options = {}) {
  const makeToken = options.randomToken;
  return makeToken ? String(makeToken()) : randomBytes(12).toString("hex");
}

function newModelInstallLockOwner(options = {}) {
  const configuredToken = typeof options.lockToken === "function"
    ? options.lockToken()
    : options.lockToken;
  const token = configuredToken === undefined
    ? randomBytes(16).toString("hex")
    : String(configuredToken);
  if (!/^[a-f0-9]{32}$/u.test(token)) {
    throw new Error("Embedding model install lock token must be 32 lowercase hex characters");
  }
  const host = typeof options.hostname === "function"
    ? options.hostname()
    : options.hostname || os.hostname();
  const pid = options.pid === undefined ? process.pid : Number(options.pid);
  const acquiredAt = currentTime(options);
  if (
    typeof host !== "string" ||
    !host ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(acquiredAt)
  ) {
    throw new Error("Embedding model install lock owner metadata is invalid");
  }
  return {
    version: 1,
    pid,
    hostname: host,
    token,
    acquiredAt: new Date(acquiredAt).toISOString(),
  };
}

async function plainModelInstallLockDirectoryExists(directory, options = {}) {
  const fsp = options.fsp || fs.promises;
  let directoryMetadata;
  try {
    directoryMetadata = await fsp.lstat(directory);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`Embedding model install lock is not a plain directory: ${directory}`);
  }
  return true;
}

async function readModelInstallLockOwner(directory, options = {}) {
  const fsp = options.fsp || fs.promises;
  const ownerPath = path.join(directory, MODEL_INSTALL_LOCK_OWNER_FILE);
  let ownerSource;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!await plainModelInstallLockDirectoryExists(directory, options)) return undefined;
    try {
      const ownerMetadata = await fsp.lstat(ownerPath);
      if (
        ownerMetadata.isSymbolicLink() ||
        !ownerMetadata.isFile() ||
        ownerMetadata.size > 4_096
      ) {
        throw new Error(`Embedding model install lock has invalid owner metadata: ${ownerPath}`);
      }
      ownerSource = await fsp.readFile(ownerPath, "utf8");
      break;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      // The live lock can be owner-token-renamed to its release directory
      // between the directory and owner-file lookups. Recheck the live path:
      // disappearance means normal contention; a persistently ownerless lock
      // is damaged and must not be silently stolen.
      if (!await plainModelInstallLockDirectoryExists(directory, options)) return undefined;
      if (attempt === 2) {
        throw new Error(`Embedding model install lock is missing owner metadata: ${ownerPath}`);
      }
      await Promise.resolve();
    }
  }
  if (ownerSource === undefined) return undefined;
  let owner;
  try {
    owner = JSON.parse(ownerSource);
  } catch (error) {
    throw new Error(`Embedding model install lock has unreadable owner metadata: ${errorMessage(error)}`);
  }
  if (
    !owner ||
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    !owner.hostname ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9]{32}$/u.test(owner.token) ||
    typeof owner.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(owner.acquiredAt))
  ) {
    throw new Error(`Embedding model install lock has invalid owner metadata: ${ownerPath}`);
  }
  return owner;
}

function modelInstallLockOwnerState(owner, options = {}) {
  const host = typeof options.hostname === "function"
    ? options.hostname()
    : options.hostname || os.hostname();
  if (owner.hostname.toLowerCase() !== String(host).toLowerCase()) return "unknown";
  const probe = options.processKill || process.kill.bind(process);
  try {
    probe(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (isFileSystemError(error, "ESRCH")) return "dead";
    if (isFileSystemError(error, "EPERM")) return "alive";
    return "unknown";
  }
}

async function writeModelInstallLockOwner(directory, owner, options = {}) {
  const fsp = options.fsp || fs.promises;
  await fsp.mkdir(directory, { mode: 0o700 });
  const ownerPath = path.join(directory, MODEL_INSTALL_LOCK_OWNER_FILE);
  let handle;
  try {
    handle = await fsp.open(ownerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the owner write failure.
      }
    }
    try {
      await fsp.unlink(ownerPath);
    } catch (cleanupError) {
      if (!isFileSystemError(cleanupError, "ENOENT")) {
        // Preserve the owner write failure.
      }
    }
    try {
      await fsp.rmdir(directory);
    } catch (cleanupError) {
      if (!isFileSystemError(cleanupError, "ENOENT")) {
        // Preserve the owner write failure.
      }
    }
    throw error;
  }
}

async function removeModelInstallLockIfOwned(directory, expectedToken, options = {}) {
  const fsp = options.fsp || fs.promises;
  const owner = await readModelInstallLockOwner(directory, options);
  if (!owner || owner.token !== expectedToken) return false;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0].name !== MODEL_INSTALL_LOCK_OWNER_FILE ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new Error(`Refusing to remove unexpected embedding model lock contents: ${directory}`);
  }
  const ownerPath = path.join(directory, MODEL_INSTALL_LOCK_OWNER_FILE);
  try {
    await fsp.unlink(ownerPath);
    await fsp.rmdir(directory);
    return true;
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    return false;
  }
}

async function renameOwnedModelInstallLock(
  source,
  destination,
  expectedToken,
  options = {},
) {
  const fsp = options.fsp || fs.promises;
  const timeoutMs = positiveDuration(
    options.lockReleaseTimeoutMs,
    2_000,
    "lockReleaseTimeoutMs",
  );
  const deadline = currentTime(options) + timeoutMs;
  while (true) {
    const owner = await readModelInstallLockOwner(source, options);
    if (!owner || owner.token !== expectedToken) {
      throw new Error("Embedding model install lock ownership changed before release");
    }
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      if (!isReplaceContention(error) || currentTime(options) >= deadline) throw error;
      await wait(Math.min(MODEL_INSTALL_LOCK_RETRY_MS, deadline - currentTime(options)), options);
    }
  }
}

async function acquireModelInstallLock(modelDirectory, options = {}) {
  const fsp = options.fsp || fs.promises;
  const lockDirectory = `${path.resolve(modelDirectory)}${MODEL_INSTALL_LOCK_SUFFIX}`;
  const owner = newModelInstallLockOwner(options);
  const stagingDirectory = `${lockDirectory}.staging-${owner.token}`;
  await writeModelInstallLockOwner(stagingDirectory, owner, options);
  const timeoutMs = positiveDuration(
    options.lockTimeoutMs,
    MODEL_INSTALL_LOCK_TIMEOUT_MS,
    "lockTimeoutMs",
  );
  const deadline = currentTime(options) + timeoutMs;

  try {
    while (true) {
      try {
        await fsp.rename(stagingDirectory, lockDirectory);
        break;
      } catch (renameError) {
        const current = await readModelInstallLockOwner(lockDirectory, options);
        if (current && modelInstallLockOwnerState(current, options) === "dead") {
          // The permanent stale-token tombstone stops a delayed contender that
          // also observed owner T from renaming a newer live owner U.
          const staleDirectory = `${lockDirectory}.stale-${current.token}`;
          try {
            await fsp.rename(lockDirectory, staleDirectory);
            continue;
          } catch {
            // Another contender changed the lock; re-read it on the next pass.
          }
        }
        let stagingExists = true;
        try {
          await fsp.lstat(stagingDirectory);
        } catch (error) {
          if (isFileSystemError(error, "ENOENT")) stagingExists = false;
          else throw error;
        }
        if (!stagingExists) throw renameError;
        const remaining = deadline - currentTime(options);
        if (remaining <= 0) {
          const active = await readModelInstallLockOwner(lockDirectory, options);
          const description = active
            ? `pid ${active.pid} on ${active.hostname}`
            : "an owner whose identity cannot be verified";
          throw new Error(`Embedding model installation is locked by ${description}`);
        }
        await wait(Math.min(MODEL_INSTALL_LOCK_RETRY_MS, remaining), options);
      }
    }
  } catch (error) {
    try {
      await removeModelInstallLockIfOwned(stagingDirectory, owner.token, options);
    } catch {
      // Preserve the acquisition error.
    }
    try {
      await removeModelInstallLockIfOwned(lockDirectory, owner.token, options);
    } catch {
      // Preserve the acquisition error.
    }
    throw error;
  }

  let released = false;
  return {
    lockDirectory,
    owner,
    async release() {
      if (released) return;
      const current = await readModelInstallLockOwner(lockDirectory, options);
      if (!current || current.token !== owner.token) {
        throw new Error("Embedding model install lock ownership changed before release");
      }
      const releaseDirectory = `${lockDirectory}.release-${owner.token}`;
      await renameOwnedModelInstallLock(
        lockDirectory,
        releaseDirectory,
        owner.token,
        options,
      );
      const moved = await readModelInstallLockOwner(releaseDirectory, options);
      if (!moved || moved.token !== owner.token) {
        throw new Error("Embedding model install lock ownership changed during release");
      }
      released = true;
      try {
        await removeModelInstallLockIfOwned(releaseDirectory, owner.token, options);
      } catch (error) {
        if (!isReplaceContention(error)) throw error;
        // The owner-token rename already released the live lock. A uniquely
        // named cleanup directory cannot block another installer.
      }
    },
  };
}

async function withModelInstallLock(modelDirectory, options, action) {
  const acquired = await acquireModelInstallLock(modelDirectory, options);
  let result;
  let actionError;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  let releaseError;
  try {
    await acquired.release();
  } catch (error) {
    releaseError = error;
  }
  if (actionError !== undefined) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [actionError, releaseError],
        "Embedding model installation failed and its lock could not be released",
      );
    }
    throw actionError;
  }
  if (releaseError !== undefined) throw releaseError;
  return result;
}

async function downloadHttpsFile(input, options = {}) {
  const fsp = options.fsp || fs.promises;
  const makeHash = options.createHash || createHash;
  const destinationPath = path.resolve(input.destinationPath);
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const stagingPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.download-${process.pid}-${randomToken(options)}.tmp`,
  );
  const deadlineAt = downloadDeadline(options);
  const networkOptions = { ...options, deadlineAt };
  const openResponse = options.openResponse || ((url) => requestHttpsResponse(url, networkOptions));
  const idleTimeoutMs = positiveDuration(
    options.idleTimeoutMs ?? options.timeoutMs,
    DOWNLOAD_IDLE_TIMEOUT_MS,
    "idleTimeoutMs",
  );
  let handle;
  let response;
  let responseSocket;
  let responseTimeout;
  try {
    handle = await fsp.open(stagingPath, "wx", 0o600);
    response = await openResponse(input.url, networkOptions);
    const remaining = remainingDownloadTime(deadlineAt, options);
    const scheduleTimeout = options.setTimeout || setTimeout;
    responseTimeout = scheduleTimeout(() => {
      if (response && typeof response.destroy === "function") {
        response.destroy(new Error("Embedding model download exceeded its absolute deadline"));
      }
    }, remaining);
    responseSocket = response && response.socket;
    if (responseSocket && typeof responseSocket.setTimeout === "function") {
      responseSocket.setTimeout(idleTimeoutMs, () => {
        if (response && typeof response.destroy === "function") {
          response.destroy(new Error(
            `Embedding model download was idle for ${idleTimeoutMs}ms`,
          ));
        }
      });
    }
    const contentLength = response.headers && response.headers["content-length"];
    if (
      contentLength !== undefined &&
      Number.isSafeInteger(Number(contentLength)) &&
      Number(contentLength) !== input.size
    ) {
      discardHttpsResponse(response);
      throw new Error(
        `Embedding model download declared ${contentLength} bytes; expected ${input.size}`,
      );
    }
    const digest = makeHash("sha256");
    let size = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > input.size) {
        if (typeof response.destroy === "function") response.destroy();
        throw new Error(`Embedding model download exceeded expected size ${input.size}`);
      }
      digest.update(buffer);
      await writeAll(handle, buffer);
    }
    if (responseTimeout !== undefined) {
      const cancelTimeout = options.clearTimeout || clearTimeout;
      cancelTimeout(responseTimeout);
      responseTimeout = undefined;
    }
    if (responseSocket && typeof responseSocket.setTimeout === "function") {
      responseSocket.setTimeout(0);
      responseSocket = undefined;
    }
    const sha256 = digest.digest("hex");
    if (size !== input.size) {
      throw new Error(`Embedding model download contained ${size} bytes; expected ${input.size}`);
    }
    if (sha256 !== input.sha256) {
      throw new Error("Embedding model download failed SHA256 verification");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(stagingPath, destinationPath, options);
    return { path: destinationPath, size, sha256 };
  } finally {
    if (responseTimeout !== undefined) {
      const cancelTimeout = options.clearTimeout || clearTimeout;
      cancelTimeout(responseTimeout);
    }
    if (responseSocket && typeof responseSocket.setTimeout === "function") {
      try {
        responseSocket.setTimeout(0);
      } catch {
        // The response may already have detached or destroyed its socket.
      }
    }
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the download or verification error.
      }
    }
    try {
      await fsp.unlink(stagingPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

async function writeManifest(modelDirectory, manifest, options = {}) {
  const fsp = options.fsp || fs.promises;
  const manifestPath = path.join(modelDirectory, MANIFEST_FILE);
  const stagingPath = path.join(
    modelDirectory,
    `.${MANIFEST_FILE}.write-${process.pid}-${randomToken(options)}.tmp`,
  );
  let handle;
  try {
    handle = await fsp.open(stagingPath, "wx", 0o600);
    await handle.writeFile(serializedManifest(manifest), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(stagingPath, manifestPath, options);
    return manifestPath;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the write or verification error.
      }
    }
    try {
      await fsp.unlink(stagingPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

async function prepareEmbeddingModel(options = {}) {
  const manifest = assertManifest(options.manifest || EMBEDDING_MODEL_MANIFEST);
  const modelDirectory = await resolveEmbeddingModelDirectory(options);
  const fsp = options.fsp || fs.promises;
  const download = options.downloadFile || downloadHttpsFile;
  await fsp.mkdir(modelDirectory, { recursive: true, mode: 0o700 });

  return withModelInstallLock(modelDirectory, options, async () => {
    const deadlineAt = downloadDeadline(options);
    const downloadOptions = { ...options, deadlineAt };
    const downloaded = [];
    const reused = [];
    for (const file of manifest.files) {
      try {
        await verifyAsset(modelDirectory, file, options);
        reused.push(file.path);
        continue;
      } catch (error) {
        const destinationPath = resolveInside(modelDirectory, file.path);
        try {
          const metadata = await fsp.lstat(destinationPath);
          if (metadata.isSymbolicLink() || !metadata.isFile()) throw error;
        } catch (metadataError) {
          if (!isFileSystemError(metadataError, "ENOENT")) throw metadataError;
        }
      }

      await download(
        {
          url: modelFileUrl(manifest, file),
          destinationPath: resolveInside(modelDirectory, file.path),
          size: file.size,
          sha256: file.sha256,
        },
        downloadOptions,
      );
      await verifyAsset(modelDirectory, file, options);
      downloaded.push(file.path);
    }

    await writeManifest(modelDirectory, manifest, options);
    const verified = await verifyEmbeddingModel({
      ...options,
      manifest,
      modelDirectory,
    });
    return {
      ...verified,
      downloaded,
      reused,
    };
  });
}

async function runCli(argv = process.argv.slice(2)) {
  const action = argv[0];
  if (action !== "prepare" && action !== "verify") {
    throw new Error("Usage: node scripts/embedding-model.cjs <prepare|verify>");
  }
  const result = action === "prepare"
    ? await prepareEmbeddingModel()
    : await verifyEmbeddingModel();
  const totalBytes = result.manifest.files.reduce((sum, file) => sum + file.size, 0);
  process.stdout.write(
    `EASY CODE: embedding model ${action === "prepare" ? "is ready" : "verified"} ` +
    `at ${result.modelDirectory} (${totalBytes} bytes).\n`,
  );
  return result;
}

module.exports = {
  EMBEDDING_MODEL_MANIFEST,
  MANIFEST_FILE,
  MODEL_DIRECTORY,
  acquireModelInstallLock,
  assertManifest,
  downloadHttpsFile,
  manifestDocument,
  modelFileUrl,
  prepareEmbeddingModel,
  requestHttpsResponse,
  resolveEmbeddingModelDirectory,
  runCli,
  serializedManifest,
  verifyEmbeddingModel,
};

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`EASY CODE: embedding model operation failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
