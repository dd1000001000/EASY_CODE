import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  EASY_CODE_RUNTIME_VERSION,
  PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
} from "./generated.js";
import { PromptBundleCatalog } from "./catalog.js";
import { verifyPromptBundleDirectory } from "./manifest.js";
import {
  getEasyCodeHome,
  getPackagedPromptBundleDirectory,
  promptBundleDirectoryName,
} from "./paths.js";
import {
  PROMPT_BUNDLE_FORMAT_VERSION,
  type ActivePromptBundleRecord,
  type InstalledPromptBundle,
  type PromptBundleBinding,
} from "./types.js";
import { canonicalJson } from "./manifest.js";

const INSTALL_LOCK_STALE_MS = 60_000;
const INSTALL_LOCK_WAIT_MS = 15_000;
const INSTALL_LOCK_POLL_MS = 40;
let activeCatalog: PromptBundleCatalog | undefined;

export interface PromptBundleEnsureOptions {
  /** @internal Test-only dependency injection. Production callers must use ensurePromptBundle(). */
  readonly homeDirectory: string;
  /** @internal Test-only dependency injection. */
  readonly packagedBundleDirectory: string;
  /** @internal Test-only dependency injection. */
  readonly expectedManifestHash: string;
  /** @internal Test-only dependency injection. */
  readonly runtimeVersion: string;
  readonly activateProcessCatalog?: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`EASY CODE private resource path is not a real directory: ${directory}`);
  }
  await chmod(directory, 0o700).catch(() => undefined);
}

async function acquireInstallLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > INSTALL_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      if (Date.now() - startedAt >= INSTALL_LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for another EASY CODE Prompt Bundle installation");
      }
      await delay(INSTALL_LOCK_POLL_MS);
    }
  }
}

async function readVerifiedBundle(
  root: string,
  expectedManifestHash: string | undefined,
  runtimeVersion: string,
): Promise<InstalledPromptBundle> {
  const verified = await verifyPromptBundleDirectory(root, {
    expectedManifestHash,
    runtimeVersion,
  });
  return { root, ...verified };
}

async function copyVerifiedBundle(
  source: InstalledPromptBundle,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const relativePath of Object.keys(source.manifest.files)) {
    const sourcePath = path.join(source.root, ...relativePath.split("/"));
    const targetPath = path.join(target, ...relativePath.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o600).catch(() => undefined);
  }
  await copyFile(source.manifestPath, path.join(target, "manifest.json"));
  await chmod(path.join(target, "manifest.json"), 0o600).catch(() => undefined);
}

async function installAtomically(
  source: InstalledPromptBundle,
  bundlesRoot: string,
  destination: string,
  runtimeVersion: string,
): Promise<InstalledPromptBundle> {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const staging = path.join(bundlesRoot, `.install-${suffix}`);
  const quarantine = path.join(bundlesRoot, `.corrupt-${suffix}`);
  let quarantined = false;
  try {
    await copyVerifiedBundle(source, staging);
    await readVerifiedBundle(staging, source.manifestHash, runtimeVersion);
    try {
      await rename(destination, quarantine);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (quarantined) await rename(quarantine, destination).catch(() => undefined);
      throw error;
    }
    if (quarantined) await rm(quarantine, { recursive: true, force: true });
    return await readVerifiedBundle(destination, source.manifestHash, runtimeVersion);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (quarantined) await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeActiveRecord(home: string, bundle: InstalledPromptBundle): Promise<void> {
  const active: ActivePromptBundleRecord = {
    formatVersion: PROMPT_BUNDLE_FORMAT_VERSION,
    bundleVersion: bundle.manifest.bundleVersion,
    directory: promptBundleDirectoryName(bundle.manifest.bundleVersion),
    manifestHash: bundle.manifestHash,
    activatedAt: new Date().toISOString(),
  };
  const destination = path.join(home, "active.json");
  const temporary = path.join(home, `.active-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const previous = path.join(home, `.active-${process.pid}-${randomBytes(8).toString("hex")}.old`);
  await writeFile(temporary, `${JSON.stringify(active, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  let movedPrevious = false;
  try {
    try {
      await rename(destination, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (movedPrevious) await rename(previous, destination).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (movedPrevious) await rm(previous, { force: true }).catch(() => undefined);
  }
  await chmod(destination, 0o600).catch(() => undefined);
}

async function createCatalog(bundle: InstalledPromptBundle): Promise<PromptBundleCatalog> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const relativePath of Object.keys(bundle.manifest.files)) {
    const value = await readFile(path.join(bundle.root, ...relativePath.split("/")));
    try {
      files.set(relativePath, decoder.decode(value));
    } catch {
      throw new Error(`Prompt Bundle resource is not valid UTF-8: ${relativePath}`);
    }
  }
  return new PromptBundleCatalog(bundle, files);
}

export async function ensurePromptBundleForTesting(
  options: PromptBundleEnsureOptions,
): Promise<PromptBundleCatalog> {
  const source = await readVerifiedBundle(
    options.packagedBundleDirectory,
    options.expectedManifestHash,
    options.runtimeVersion,
  );
  const home = path.resolve(options.homeDirectory);
  await assertPrivateDirectory(home);
  const bundlesRoot = path.join(home, "bundles");
  await assertPrivateDirectory(bundlesRoot);
  const lockPath = path.join(home, "install.lock");
  const release = await acquireInstallLock(lockPath);
  let installed: InstalledPromptBundle;
  try {
    const destination = path.join(
      bundlesRoot,
      promptBundleDirectoryName(source.manifest.bundleVersion),
    );
    try {
      installed = await readVerifiedBundle(destination, source.manifestHash, options.runtimeVersion);
    } catch {
      installed = await installAtomically(
        source,
        bundlesRoot,
        destination,
        options.runtimeVersion,
      );
    }
    await writeActiveRecord(home, installed);
  } finally {
    await release();
  }
  const catalog = await createCatalog(installed);
  if (options.activateProcessCatalog !== false) activeCatalog = catalog;
  return catalog;
}

/** Install, verify or repair the fixed per-user Prompt Bundle. */
export function ensurePromptBundle(): Promise<PromptBundleCatalog> {
  if (activeCatalog) return Promise.resolve(activeCatalog);
  return ensurePromptBundleForTesting({
    homeDirectory: getEasyCodeHome(),
    packagedBundleDirectory: getPackagedPromptBundleDirectory(),
    expectedManifestHash: PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
    runtimeVersion: EASY_CODE_RUNTIME_VERSION,
  });
}

/** Synchronous, immutable Catalog available after ensurePromptBundle() resolves. */
export function loadPromptBundleCatalog(): PromptBundleCatalog {
  if (!activeCatalog) {
    throw new Error("Prompt Bundle is not active; call and await ensurePromptBundle() first");
  }
  return activeCatalog;
}

/** Stable identity used to bind new sessions and validate Resume. */
export function activePromptBundleBinding(): PromptBundleBinding {
  const catalog = loadPromptBundleCatalog();
  const toolContracts = Object.fromEntries(
    Object.entries(catalog.manifest.tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]) => [id, {
        contractVersion: entry.contractVersion,
        contentHash: entry.contentHash,
        ...(entry.schemaHash ? { schemaHash: entry.schemaHash } : {}),
      }]),
  );
  const toolCatalogHash = `sha256:${createHash("sha256")
    .update(canonicalJson(toolContracts))
    .digest("hex")}`;
  return Object.freeze({
    formatVersion: catalog.manifest.formatVersion,
    bundleVersion: catalog.manifest.bundleVersion,
    bundleHash: catalog.manifest.bundleHash,
    manifestHash: catalog.manifestHash,
    toolCatalogHash,
  });
}
