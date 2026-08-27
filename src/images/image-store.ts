import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";

import type {
  ImageAttachment,
  SupportedImageMediaType,
} from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { MAX_THREAD_IMAGE_NUMBER } from "./labels.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 8_192;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGES_PER_MODEL_REQUEST = MAX_THREAD_IMAGE_NUMBER;
export const MAX_TOTAL_IMAGE_BYTES_PER_MODEL_REQUEST = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_PIXELS_PER_MODEL_REQUEST = 80_000_000;
export const DEFAULT_IMAGE_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ImageGarbageCollectionResult {
  readonly acquiredLock: boolean;
  readonly referencedImages: number;
  readonly committedRecovered: number;
  readonly orphanImagesRemoved: number;
  readonly pendingImagesPreserved: number;
}

export interface InspectedImage {
  readonly mediaType: SupportedImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ImageStoreOptions {
  readonly maxImageBytes?: number;
  readonly maxImageEdge?: number;
  readonly maxImagePixels?: number;
  readonly orphanGraceMs?: number;
  /** Deterministic lifecycle hooks used by isolated tests. */
  readonly now?: () => number;
  readonly processId?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly leaseId?: string;
}

export interface ImageAttachmentCollectionLimits {
  readonly maxImages?: number;
  readonly maxTotalBytes?: number;
  readonly maxTotalPixels?: number;
}

export interface ImageAttachmentCollectionSummary {
  readonly imageCount: number;
  readonly totalBytes: number;
  readonly totalPixels: number;
}

const STORAGE_KEY_PATTERN =
  /^attachments\/([a-f0-9]{32})\/(image_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(png|jpg|webp|gif)$/u;
const IMAGE_ID_PATTERN =
  /^image_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const IMAGE_LABEL_PATTERN = /^Image #[1-9][0-9]{0,2}$/u;
const THREAD_DIRECTORY_PATTERN = /^[a-f0-9]{32}$/u;
const STORED_IMAGE_FILENAME_PATTERN =
  /^image_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:png|jpg|webp|gif)$/u;
const LEASE_ID_PATTERN =
  /^lease_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PENDING_MARKER_SUFFIX = ".pending.json";
const JOURNAL_STORAGE_KEY_PATTERN =
  /attachments\/[a-f0-9]{32}\/image_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:png|jpg|webp|gif)/gu;
const ATTACHMENT_KEYS = new Set([
  "id",
  "label",
  "mediaType",
  "storageKey",
  "sha256",
  "byteSize",
  "width",
  "height",
  "sourceName",
]);

interface PendingImageMarker {
  readonly version: 1;
  readonly leaseId: string;
  readonly pid: number;
  readonly storageKey: string;
  readonly createdAt: number;
}

interface LeaseRecord {
  readonly version: 1;
  readonly leaseId: string;
  readonly pid: number;
  readonly createdAt: number;
}

interface GarbageCollectionLock {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

export class ImageStore {
  private readonly dataDir: string;
  private readonly attachmentsRoot: string;
  private readonly pendingRoot: string;
  private readonly leasesRoot: string;
  private readonly maxImageBytes: number;
  private readonly maxImageEdge: number;
  private readonly maxImagePixels: number;
  private readonly orphanGraceMs: number;
  private readonly now: () => number;
  private readonly processId: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly leaseId: string;
  private readonly pendingMarkers = new Map<string, string>();
  private initialization?: Promise<ImageGarbageCollectionResult>;
  private leaseReady = false;

  constructor(dataDir: string, options: ImageStoreOptions = {}) {
    this.dataDir = path.resolve(dataDir);
    this.attachmentsRoot = path.join(this.dataDir, "attachments");
    this.pendingRoot = path.join(this.attachmentsRoot, ".pending");
    this.leasesRoot = path.join(this.attachmentsRoot, ".leases");
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.maxImageEdge = options.maxImageEdge ?? MAX_IMAGE_EDGE;
    this.maxImagePixels = options.maxImagePixels ?? MAX_IMAGE_PIXELS;
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_IMAGE_ORPHAN_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.leaseId = options.leaseId ?? `lease_${randomUUID()}`;
    if (!LEASE_ID_PATTERN.test(this.leaseId)) throw new Error("Image lease ID is invalid.");
    if (!Number.isInteger(this.processId) || this.processId < 1) {
      throw new Error("Image lease process ID is invalid.");
    }
    if (!Number.isFinite(this.orphanGraceMs) || this.orphanGraceMs < 0) {
      throw new Error("Image orphan grace period is invalid.");
    }
  }

  initialize(): Promise<ImageGarbageCollectionResult> {
    this.initialization ??= this.runInitialization();
    return this.initialization;
  }

  /**
   * Copy an image using one file handle for the size checks and the bounded read.
   * Pass allowedRoot for workspace-originated files so the canonical source must
   * remain inside that workspace throughout the read.
   */
  async importFile(
    threadId: string,
    label: string,
    absolutePath: string,
    sourceName?: string,
    allowedRoot?: string,
  ): Promise<ImageAttachment> {
    const lexical = path.resolve(absolutePath);
    const canonical = await realpath(lexical);
    let canonicalAllowedRoot: string | undefined;
    if (allowedRoot) {
      canonicalAllowedRoot = await realpath(path.resolve(allowedRoot));
      const rootInfo = await stat(canonicalAllowedRoot);
      if (!rootInfo.isDirectory()) throw new Error("The allowed image root is not a directory.");
      assertPathInside(canonical, canonicalAllowedRoot, "Image path escapes the allowed workspace.");
    }

    const data = await readRegularFileBounded(
      canonical,
      this.maxImageBytes,
      canonicalAllowedRoot,
    );
    return this.importBuffer(threadId, label, data, sourceName);
  }

  async importBuffer(
    threadId: string,
    label: string,
    data: Buffer,
    sourceName?: string,
  ): Promise<ImageAttachment> {
    await this.initialize();
    await this.ensureLease();
    assertThreadId(threadId);
    assertImageLabel(label);
    const inspected = inspectImageBuffer(data, {
      maxImageBytes: this.maxImageBytes,
      maxImageEdge: this.maxImageEdge,
      maxImagePixels: this.maxImagePixels,
    });
    const id = createId("image");
    const threadDirectory = threadDirectoryFor(threadId);
    const extension = extensionForMediaType(inspected.mediaType);
    const storageKey = `attachments/${threadDirectory}/${id}.${extension}`;
    const target = this.resolveStorageKey(storageKey);
    const directories = await this.prepareThreadDirectory(threadDirectory);

    let handle: FileHandle | undefined;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size !== data.length) {
        throw new Error("The private image attachment could not be written safely.");
      }
      await assertOpenedPath(
        handle,
        target,
        openedInfo,
        directories.canonicalThread,
        "Image attachment path escaped its private thread directory.",
      );
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();

    try {
      const marker = await this.createPendingMarker(storageKey);
      this.pendingMarkers.set(storageKey, marker);
    } catch (error) {
      // The UUID target was created by this call and is not durable until its
      // pending marker exists. Removing it here cannot affect a committed image.
      await unlink(target).catch(() => undefined);
      throw error;
    }

    const attachment: ImageAttachment = {
      id,
      label,
      mediaType: inspected.mediaType,
      storageKey,
      sha256: inspected.sha256,
      byteSize: inspected.byteSize,
      width: inspected.width,
      height: inspected.height,
    };
    const safeSourceName = normalizeSourceName(sourceName);
    if (safeSourceName) attachment.sourceName = safeSourceName;
    return attachment;
  }

  /** Mark an attachment durable after its owning message event has been persisted. */
  async commit(threadId: string, attachment: ImageAttachment): Promise<void> {
    await this.initialize();
    assertThreadId(threadId);
    assertAttachmentMetadata(
      attachment,
      this.maxImageBytes,
      this.maxImageEdge,
      this.maxImagePixels,
      threadId,
    );
    // Verify the exact final file before removing the orphan marker. This also
    // makes commit idempotent for attachments recovered by startup GC.
    await this.load(threadId, attachment);

    // Removing the marker must be serialized with GC. Otherwise GC can take a
    // journal-reference snapshot, commit can remove the marker after that
    // snapshot, and the final sweep can mistake an older newly-committed image
    // for an orphan. If another GC owns the lock, retaining the marker is safe:
    // the owning message is already durable and a later GC will recover it.
    const roots = await this.prepareLifecycleRoots();
    const lock = await this.acquireGarbageCollectionLock(roots.canonicalRoot);
    if (!lock) return;
    try {
      const marker = this.pendingMarkers.get(attachment.storageKey) ??
        this.pendingMarkerPath(attachment.storageKey, this.leaseId);
      try {
        await this.removePendingMarker(marker, attachment.storageKey);
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
      this.pendingMarkers.delete(attachment.storageKey);
      await this.removeEmptyPendingDirectories(marker);
    } finally {
      await this.releaseGarbageCollectionLock(lock);
    }
  }

  async load(threadId: string, attachment: ImageAttachment): Promise<Buffer> {
    await this.initialize();
    const { target, canonicalThread } = await this.resolveBoundAttachment(
      threadId,
      attachment,
    );
    const data = await readRegularFileBounded(
      target,
      this.maxImageBytes,
      canonicalThread,
      attachment.byteSize,
    );
    let inspected: InspectedImage;
    try {
      inspected = inspectImageBuffer(data, {
        maxImageBytes: this.maxImageBytes,
        maxImageEdge: this.maxImageEdge,
        maxImagePixels: this.maxImagePixels,
      });
    } catch {
      throw new Error(`Stored ${attachment.label} failed its integrity check.`);
    }
    if (
      inspected.mediaType !== attachment.mediaType ||
      inspected.sha256 !== attachment.sha256 ||
      inspected.width !== attachment.width ||
      inspected.height !== attachment.height ||
      inspected.byteSize !== attachment.byteSize
    ) {
      throw new Error(`Stored ${attachment.label} failed its integrity check.`);
    }
    return data;
  }

  async remove(threadId: string, attachment: ImageAttachment): Promise<void> {
    await this.initialize();
    assertThreadId(threadId);
    assertAttachmentMetadata(
      attachment,
      this.maxImageBytes,
      this.maxImageEdge,
      this.maxImagePixels,
      threadId,
    );
    const marker = this.pendingMarkers.get(attachment.storageKey) ??
      this.pendingMarkerPath(attachment.storageKey, this.leaseId);
    if (!(await pathExistsAsRegularFile(marker))) return;
    await this.validatePendingMarker(marker, attachment.storageKey, this.leaseId);
    const resolved = await this.resolveBoundAttachment(threadId, attachment);
    let fileInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      fileInfo = await lstat(resolved.target);
    } catch (error) {
      if (isFileNotFound(error)) return;
      throw error;
    }
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error(`Stored ${attachment.label} is not a regular attachment file.`);
    }
    const canonical = await realpath(resolved.target);
    assertPathInside(
      canonical,
      resolved.canonicalThread,
      "Image attachment path escaped its private thread directory.",
    );
    await unlink(resolved.target);
    await unlink(marker).catch((error) => {
      if (!isFileNotFound(error)) throw error;
    });
    this.pendingMarkers.delete(attachment.storageKey);
    await this.removeEmptyPendingDirectories(marker);
  }

  async garbageCollect(): Promise<ImageGarbageCollectionResult> {
    if (!this.initialization) return this.initialize();
    await this.initialization;
    return this.runGarbageCollection(false);
  }

  /**
   * Finalize referenced pending markers and eagerly discard this instance's
   * remaining uncommitted images during a graceful shutdown.
   */
  async shutdown(): Promise<ImageGarbageCollectionResult> {
    if (!this.initialization) return emptyGarbageCollectionResult(false);
    await this.initialization;
    const result = await this.runGarbageCollection(true);
    await this.releaseLeaseIfUnused();
    return result;
  }

  private async runInitialization(): Promise<ImageGarbageCollectionResult> {
    await this.prepareLifecycleRoots();
    return this.runGarbageCollection(false);
  }

  private async prepareLifecycleRoots(): Promise<{
    canonicalRoot: string;
    canonicalPending: string;
    canonicalLeases: string;
  }> {
    await mkdir(this.attachmentsRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await verifyPrivateDirectory(
      this.attachmentsRoot,
      "Image attachment root",
    );
    for (const directory of [this.pendingRoot, this.leasesRoot]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    const canonicalPending = await verifyPrivateDirectory(
      this.pendingRoot,
      "Image pending-marker directory",
    );
    const canonicalLeases = await verifyPrivateDirectory(
      this.leasesRoot,
      "Image lease directory",
    );
    assertPathInside(
      canonicalPending,
      canonicalRoot,
      "Image pending-marker directory escapes the private attachment store.",
    );
    assertPathInside(
      canonicalLeases,
      canonicalRoot,
      "Image lease directory escapes the private attachment store.",
    );
    return { canonicalRoot, canonicalPending, canonicalLeases };
  }

  private async ensureLease(): Promise<void> {
    if (this.leaseReady) return;
    const roots = await this.prepareLifecycleRoots();
    const leasePath = this.leaseRecordPath(this.leaseId);
    const record: LeaseRecord = {
      version: 1,
      leaseId: this.leaseId,
      pid: this.processId,
      createdAt: this.now(),
    };
    try {
      await writeJsonExclusive(leasePath, record, roots.canonicalLeases);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readJsonBounded(leasePath, roots.canonicalLeases);
      if (!isLeaseRecord(existing) ||
          existing.leaseId !== this.leaseId ||
          existing.pid !== this.processId) {
        throw new Error("Image lease already exists with different ownership.");
      }
    }
    this.leaseReady = true;
  }

  private async createPendingMarker(storageKey: string): Promise<string> {
    await this.ensureLease();
    const roots = await this.prepareLifecycleRoots();
    const markerPath = this.pendingMarkerPath(storageKey, this.leaseId);
    const leaseDirectory = path.dirname(path.dirname(markerPath));
    const threadDirectory = path.dirname(markerPath);
    for (const directory of [leaseDirectory, threadDirectory]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      const canonical = await verifyPrivateDirectory(
        directory,
        "Image pending-marker subdirectory",
      );
      assertPathInside(
        canonical,
        roots.canonicalPending,
        "Image pending marker escapes the private attachment store.",
      );
    }
    const marker: PendingImageMarker = {
      version: 1,
      leaseId: this.leaseId,
      pid: this.processId,
      storageKey,
      createdAt: this.now(),
    };
    await writeJsonExclusive(markerPath, marker, roots.canonicalPending);
    return markerPath;
  }

  private pendingMarkerPath(storageKey: string, leaseId: string): string {
    if (!LEASE_ID_PATTERN.test(leaseId)) throw new Error("Image lease ID is invalid.");
    const match = STORAGE_KEY_PATTERN.exec(storageKey);
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new Error("Image attachment storage key is invalid.");
    }
    const marker = path.resolve(
      this.pendingRoot,
      leaseId,
      match[1],
      `${match[2]}.${match[3]}${PENDING_MARKER_SUFFIX}`,
    );
    assertPathInside(
      marker,
      this.pendingRoot,
      "Image pending marker escapes the private attachment store.",
    );
    return marker;
  }

  private leaseRecordPath(leaseId: string): string {
    if (!LEASE_ID_PATTERN.test(leaseId)) throw new Error("Image lease ID is invalid.");
    const result = path.resolve(this.leasesRoot, `${leaseId}.json`);
    assertPathInside(result, this.leasesRoot, "Image lease path is invalid.");
    return result;
  }

  private async validatePendingMarker(
    markerPath: string,
    storageKey: string,
    leaseId: string,
  ): Promise<PendingImageMarker> {
    const roots = await this.prepareLifecycleRoots();
    const canonicalLease = await verifyPrivateDirectory(
      path.dirname(path.dirname(markerPath)),
      "Image pending lease directory",
    );
    const canonicalThread = await verifyPrivateDirectory(
      path.dirname(markerPath),
      "Image pending thread directory",
    );
    assertPathInside(
      canonicalLease,
      roots.canonicalPending,
      "Image pending lease directory escapes the private attachment store.",
    );
    assertPathInside(
      canonicalThread,
      canonicalLease,
      "Image pending thread directory escapes its lease.",
    );
    const value = await readJsonBounded(markerPath, roots.canonicalPending);
    if (!isPendingImageMarker(value) ||
        value.storageKey !== storageKey ||
        value.leaseId !== leaseId) {
      throw new Error("Image pending marker has invalid ownership or contents.");
    }
    return value;
  }

  private async removePendingMarker(
    markerPath: string,
    storageKey: string,
  ): Promise<void> {
    const leaseId = path.basename(path.dirname(path.dirname(markerPath)));
    await this.validatePendingMarker(markerPath, storageKey, leaseId);
    await unlink(markerPath);
  }

  private async removeEmptyPendingDirectories(markerPath: string): Promise<void> {
    await removeDirectoryIfEmpty(path.dirname(markerPath));
    await removeDirectoryIfEmpty(path.dirname(path.dirname(markerPath)));
  }

  private async runGarbageCollection(
    cleanCurrentLease: boolean,
  ): Promise<ImageGarbageCollectionResult> {
    const roots = await this.prepareLifecycleRoots();
    const lock = await this.acquireGarbageCollectionLock(roots.canonicalRoot);
    if (!lock) return emptyGarbageCollectionResult(false);
    try {
      const referenced = await this.collectReferencedStorageKeys();
      let committedRecovered = 0;
      let orphanImagesRemoved = 0;
      let pendingImagesPreserved = 0;
      const preservedPending = new Set<string>();
      const leaseDirectories = await safeDirectoryEntries(this.pendingRoot);
      for (const leaseEntry of leaseDirectories) {
        if (!LEASE_ID_PATTERN.test(leaseEntry.name)) continue;
        if (!leaseEntry.isDirectory() || leaseEntry.isSymbolicLink()) {
          throw new Error("Image pending lease entry must be a real directory.");
        }
        const leaseDirectory = path.join(this.pendingRoot, leaseEntry.name);
        const canonicalLeaseDirectory = await verifyPrivateDirectory(
          leaseDirectory,
          "Image pending lease directory",
        );
        assertPathInside(
          canonicalLeaseDirectory,
          roots.canonicalPending,
          "Image pending lease directory escapes the private attachment store.",
        );
        const threadEntries = await safeDirectoryEntries(leaseDirectory);
        for (const threadEntry of threadEntries) {
          if (!THREAD_DIRECTORY_PATTERN.test(threadEntry.name)) continue;
          if (!threadEntry.isDirectory() || threadEntry.isSymbolicLink()) {
            throw new Error("Image pending thread entry must be a real directory.");
          }
          const markerDirectory = path.join(leaseDirectory, threadEntry.name);
          const canonicalMarkerDirectory = await verifyPrivateDirectory(
            markerDirectory,
            "Image pending thread directory",
          );
          assertPathInside(
            canonicalMarkerDirectory,
            canonicalLeaseDirectory,
            "Image pending thread directory escapes its lease.",
          );
          const markerEntries = await safeDirectoryEntries(markerDirectory);
          for (const markerEntry of markerEntries) {
            if (!markerEntry.name.endsWith(PENDING_MARKER_SUFFIX)) continue;
            if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
              throw new Error("Image pending marker must be a regular file.");
            }
            const markerPath = path.join(markerDirectory, markerEntry.name);
            const inferredStorageKey = storageKeyFromPendingMarkerName(
              threadEntry.name,
              markerEntry.name,
            );
            let marker: PendingImageMarker;
            try {
              const parsed = await readJsonBounded(markerPath, canonicalMarkerDirectory);
              if (!isPendingImageMarker(parsed) ||
                  parsed.leaseId !== leaseEntry.name ||
                  !parsed.storageKey.startsWith(`attachments/${threadEntry.name}/`) ||
                  markerEntry.name !==
                    `${path.posix.basename(parsed.storageKey)}${PENDING_MARKER_SUFFIX}`) {
                if (inferredStorageKey) preservedPending.add(inferredStorageKey);
                pendingImagesPreserved += 1;
                continue;
              }
              marker = parsed;
            } catch {
              // Corrupt lifecycle metadata is never a reason to delete a file.
              // A strict marker filename still identifies the one final image
              // that must be conservatively retained for manual recovery.
              if (inferredStorageKey) preservedPending.add(inferredStorageKey);
              pendingImagesPreserved += 1;
              continue;
            }

            const finalExists = await this.safeFinalFileExists(marker.storageKey);
            if (referenced.has(marker.storageKey)) {
              if (finalExists) {
                await unlink(markerPath);
                this.pendingMarkers.delete(marker.storageKey);
                committedRecovered += 1;
              } else {
                preservedPending.add(marker.storageKey);
                pendingImagesPreserved += 1;
              }
              continue;
            }

            const markerInfo = await lstat(markerPath);
            const active = this.isProcessAlive(marker.pid);
            const stale = this.now() - Math.max(marker.createdAt, markerInfo.mtimeMs) >=
              this.orphanGraceMs;
            if ((cleanCurrentLease && marker.leaseId === this.leaseId) ||
                (!active && stale)) {
              if (finalExists) await this.safeDeleteFinalFile(marker.storageKey);
              await unlink(markerPath);
              this.pendingMarkers.delete(marker.storageKey);
              orphanImagesRemoved += finalExists ? 1 : 0;
            } else {
              preservedPending.add(marker.storageKey);
              pendingImagesPreserved += 1;
            }
          }
          await removeDirectoryIfEmpty(markerDirectory);
        }
        await removeDirectoryIfEmpty(leaseDirectory);
      }

      const finalThreadEntries = await safeDirectoryEntries(this.attachmentsRoot);
      for (const threadEntry of finalThreadEntries) {
        if (!THREAD_DIRECTORY_PATTERN.test(threadEntry.name)) continue;
        if (!threadEntry.isDirectory() || threadEntry.isSymbolicLink()) {
          throw new Error("Image attachment thread entry must be a real directory.");
        }
        const threadDirectory = path.join(this.attachmentsRoot, threadEntry.name);
        const canonicalThread = await verifyPrivateDirectory(
          threadDirectory,
          "Image attachment thread directory",
        );
        assertPathInside(
          canonicalThread,
          roots.canonicalRoot,
          "Image attachment thread directory escapes its store.",
        );
        for (const imageEntry of await safeDirectoryEntries(threadDirectory)) {
          if (!imageEntry.isFile() || imageEntry.isSymbolicLink() ||
              !STORED_IMAGE_FILENAME_PATTERN.test(imageEntry.name)) continue;
          const storageKey = `attachments/${threadEntry.name}/${imageEntry.name}`;
          if (referenced.has(storageKey) || preservedPending.has(storageKey)) continue;
          const imagePath = path.join(threadDirectory, imageEntry.name);
          const info = await lstat(imagePath);
          if (this.now() - info.mtimeMs < this.orphanGraceMs) continue;
          await this.safeDeleteFinalFile(storageKey);
          orphanImagesRemoved += 1;
        }
        await removeDirectoryIfEmpty(threadDirectory);
      }

      await this.cleanUnusedLeaseRecords(cleanCurrentLease);
      return {
        acquiredLock: true,
        referencedImages: referenced.size,
        committedRecovered,
        orphanImagesRemoved,
        pendingImagesPreserved,
      };
    } finally {
      await this.releaseGarbageCollectionLock(lock).catch(() => undefined);
    }
  }

  private async collectReferencedStorageKeys(): Promise<Set<string>> {
    const referenced = new Set<string>();
    const threadsRoot = path.join(this.dataDir, "threads");
    let rootInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      rootInfo = await lstat(threadsRoot);
    } catch (error) {
      if (isFileNotFound(error)) return referenced;
      throw error;
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("Thread journal root is unsafe; attachment GC was refused.");
    }
    const canonicalThreads = await realpath(threadsRoot);
    for (const threadEntry of await safeDirectoryEntries(threadsRoot)) {
      if (threadEntry.isSymbolicLink()) {
        throw new Error("Thread journal directory is a symlink or junction; attachment GC was refused.");
      }
      if (!threadEntry.isDirectory()) continue;
      const journalPath = path.join(threadsRoot, threadEntry.name, "events.jsonl");
      let journalInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        journalInfo = await lstat(journalPath);
      } catch (error) {
        if (isFileNotFound(error)) continue;
        throw error;
      }
      if (journalInfo.isSymbolicLink() || !journalInfo.isFile()) continue;
      const canonicalJournal = await realpath(journalPath);
      assertPathInside(
        canonicalJournal,
        canonicalThreads,
        "Thread journal escapes the private data directory.",
      );
      await scanStorageKeys(journalPath, referenced);
    }
    return referenced;
  }

  private async safeFinalFileExists(storageKey: string): Promise<boolean> {
    const target = this.resolveStorageKey(storageKey);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) return false;
      const canonicalRoot = await verifyPrivateDirectory(
        this.attachmentsRoot,
        "Image attachment root",
      );
      const canonicalThread = await verifyPrivateDirectory(
        path.dirname(target),
        "Image attachment thread directory",
      );
      assertPathInside(
        canonicalThread,
        canonicalRoot,
        "Image attachment thread directory escapes the private attachment store.",
      );
      const canonical = await realpath(target);
      assertPathInside(
        canonical,
        canonicalThread,
        "Image attachment path escapes its private thread directory.",
      );
      return true;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
  }

  private async safeDeleteFinalFile(storageKey: string): Promise<void> {
    const target = this.resolveStorageKey(storageKey);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Refusing to remove a non-regular image attachment.");
    }
    const canonicalRoot = await verifyPrivateDirectory(
      this.attachmentsRoot,
      "Image attachment root",
    );
    const canonicalThread = await verifyPrivateDirectory(
      path.dirname(target),
      "Image attachment thread directory",
    );
    assertPathInside(
      canonicalThread,
      canonicalRoot,
      "Image attachment thread directory escapes the private attachment store.",
    );
    const canonical = await realpath(target);
    assertPathInside(
      canonical,
      canonicalThread,
      "Image attachment path escapes its private thread directory.",
    );
    await unlink(target);
  }

  private async cleanUnusedLeaseRecords(cleanCurrentLease: boolean): Promise<void> {
    const canonicalLeases = await verifyPrivateDirectory(
      this.leasesRoot,
      "Image lease directory",
    );
    for (const entry of await safeDirectoryEntries(this.leasesRoot)) {
      if (!entry.isFile() || entry.isSymbolicLink() ||
          !entry.name.endsWith(".json")) continue;
      const leaseId = entry.name.slice(0, -5);
      if (!LEASE_ID_PATTERN.test(leaseId)) continue;
      const leasePath = path.join(this.leasesRoot, entry.name);
      let record: LeaseRecord;
      try {
        const parsed = await readJsonBounded(leasePath, canonicalLeases);
        if (!isLeaseRecord(parsed) || parsed.leaseId !== leaseId) continue;
        record = parsed;
      } catch {
        continue;
      }
      const pendingLeaseDirectory = path.join(this.pendingRoot, leaseId);
      if (await pathExists(pendingLeaseDirectory)) continue;
      const stale = this.now() - record.createdAt >= this.orphanGraceMs;
      if ((cleanCurrentLease && leaseId === this.leaseId) ||
          (!this.isProcessAlive(record.pid) && stale)) {
        await unlink(leasePath);
        if (leaseId === this.leaseId) this.leaseReady = false;
      }
    }
  }

  private async releaseLeaseIfUnused(): Promise<void> {
    if (!this.leaseReady) return;
    const pendingLeaseDirectory = path.join(this.pendingRoot, this.leaseId);
    if (await pathExists(pendingLeaseDirectory)) return;
    const leasePath = this.leaseRecordPath(this.leaseId);
    try {
      const canonicalLeases = await verifyPrivateDirectory(
        this.leasesRoot,
        "Image lease directory",
      );
      const parsed = await readJsonBounded(leasePath, canonicalLeases);
      if (isLeaseRecord(parsed) && parsed.leaseId === this.leaseId &&
          parsed.pid === this.processId) {
        await unlink(leasePath);
      }
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    this.leaseReady = false;
  }

  private async acquireGarbageCollectionLock(
    canonicalRoot: string,
  ): Promise<{ path: string; token: string } | undefined> {
    const lockPath = path.join(this.attachmentsRoot, ".gc-lock");
    const token = `gc_${randomUUID()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: GarbageCollectionLock = {
        version: 1,
        token,
        pid: this.processId,
        createdAt: this.now(),
      };
      try {
        await writeJsonExclusive(lockPath, record, canonicalRoot);
        return { path: lockPath, token };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      let existing: unknown;
      let lockInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        lockInfo = await lstat(lockPath);
        if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) return undefined;
        existing = await readJsonBounded(lockPath, canonicalRoot);
      } catch {
        return undefined;
      }
      const ownerAlive = isGarbageCollectionLock(existing) &&
        this.isProcessAlive(existing.pid);
      const createdAt = isGarbageCollectionLock(existing)
        ? existing.createdAt
        : lockInfo.mtimeMs;
      if (ownerAlive || this.now() - Math.max(createdAt, lockInfo.mtimeMs) <
          this.orphanGraceMs) return undefined;

      const tombstone = path.join(
        this.attachmentsRoot,
        `.gc-lock-stale-${randomUUID()}`,
      );
      try {
        await rename(lockPath, tombstone);
        await unlink(tombstone);
      } catch (error) {
        if (isFileNotFound(error)) continue;
        return undefined;
      }
    }
    return undefined;
  }

  private async releaseGarbageCollectionLock(
    lock: { path: string; token: string },
  ): Promise<void> {
    const canonicalRoot = await verifyPrivateDirectory(
      this.attachmentsRoot,
      "Image attachment root",
    );
    const value = await readJsonBounded(lock.path, canonicalRoot);
    if (!isGarbageCollectionLock(value) || value.token !== lock.token ||
        value.pid !== this.processId) {
      throw new Error("Refusing to release an image GC lock owned by another process.");
    }
    await unlink(lock.path);
  }

  private async resolveBoundAttachment(
    threadId: string,
    attachment: ImageAttachment,
  ): Promise<{ target: string; canonicalThread: string }> {
    assertThreadId(threadId);
    assertAttachmentMetadata(
      attachment,
      this.maxImageBytes,
      this.maxImageEdge,
      this.maxImagePixels,
      threadId,
    );
    const target = this.resolveStorageKey(attachment.storageKey);
    const directories = await this.getExistingThreadDirectory(threadDirectoryFor(threadId));
    return { target, canonicalThread: directories.canonicalThread };
  }

  private async prepareThreadDirectory(
    threadDirectory: string,
  ): Promise<{ canonicalRoot: string; canonicalThread: string }> {
    await mkdir(this.attachmentsRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await verifyPrivateDirectory(
      this.attachmentsRoot,
      "Image attachment root",
    );
    const threadPath = path.join(this.attachmentsRoot, threadDirectory);
    try {
      await mkdir(threadPath, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const canonicalThread = await verifyPrivateDirectory(
      threadPath,
      "Image attachment thread directory",
    );
    assertPathInside(
      canonicalThread,
      canonicalRoot,
      "Image attachment thread directory escapes the private attachment store.",
    );
    return { canonicalRoot, canonicalThread };
  }

  private async getExistingThreadDirectory(
    threadDirectory: string,
  ): Promise<{ canonicalRoot: string; canonicalThread: string }> {
    const canonicalRoot = await verifyPrivateDirectory(
      this.attachmentsRoot,
      "Image attachment root",
    );
    const canonicalThread = await verifyPrivateDirectory(
      path.join(this.attachmentsRoot, threadDirectory),
      "Image attachment thread directory",
    );
    assertPathInside(
      canonicalThread,
      canonicalRoot,
      "Image attachment thread directory escapes the private attachment store.",
    );
    return { canonicalRoot, canonicalThread };
  }

  private resolveStorageKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error("Image attachment storage key is invalid.");
    }
    const target = path.resolve(this.dataDir, ...storageKey.split("/"));
    assertPathInside(
      target,
      this.attachmentsRoot,
      "Image attachment path escapes the private attachment store.",
    );
    return target;
  }
}

export function validateImageAttachmentCollection(
  images: readonly ImageAttachment[],
  limits: ImageAttachmentCollectionLimits = {},
): ImageAttachmentCollectionSummary {
  const maxImages = limits.maxImages ?? MAX_IMAGES_PER_MODEL_REQUEST;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_IMAGE_BYTES_PER_MODEL_REQUEST;
  const maxTotalPixels = limits.maxTotalPixels ?? MAX_TOTAL_IMAGE_PIXELS_PER_MODEL_REQUEST;
  if (images.length > maxImages) {
    throw new Error(`A model request can contain at most ${maxImages} images.`);
  }
  let totalBytes = 0;
  let totalPixels = 0;
  for (const attachment of images) {
    assertAttachmentMetadata(
      attachment,
      MAX_IMAGE_BYTES,
      MAX_IMAGE_EDGE,
      MAX_IMAGE_PIXELS,
    );
    totalBytes = safeSum(totalBytes, attachment.byteSize, "combined image byte size");
    totalPixels = safeSum(
      totalPixels,
      attachment.width * attachment.height,
      "combined image pixel count",
    );
  }
  if (totalBytes > maxTotalBytes) {
    throw new Error(`Images exceed the ${formatBytes(maxTotalBytes)} combined size limit.`);
  }
  if (totalPixels > maxTotalPixels) {
    throw new Error(`Images exceed the ${maxTotalPixels.toLocaleString("en-US")} combined pixel limit.`);
  }
  return { imageCount: images.length, totalBytes, totalPixels };
}

export function inspectImageBuffer(
  data: Buffer,
  options: ImageStoreOptions = {},
): InspectedImage {
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  const maxImageEdge = options.maxImageEdge ?? MAX_IMAGE_EDGE;
  const maxImagePixels = options.maxImagePixels ?? MAX_IMAGE_PIXELS;
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error("Image data is empty.");
  }
  if (data.length > maxImageBytes) {
    throw new Error(`Image exceeds the ${formatBytes(maxImageBytes)} size limit.`);
  }

  const parsed = parseImage(data);
  if (!parsed) {
    throw new Error("Unsupported or damaged image; use PNG, JPEG, WebP, or static GIF.");
  }
  const pixels = parsed.width * parsed.height;
  if (
    parsed.width < 1 ||
    parsed.height < 1 ||
    parsed.width > maxImageEdge ||
    parsed.height > maxImageEdge ||
    !Number.isSafeInteger(pixels) ||
    pixels > maxImagePixels
  ) {
    throw new Error(
      `Image dimensions ${parsed.width}x${parsed.height} exceed the configured safety limit.`,
    );
  }
  return {
    ...parsed,
    byteSize: data.length,
    sha256: sha256(data),
  };
}

type ParsedImage = Pick<InspectedImage, "mediaType" | "width" | "height">;

function parseImage(data: Buffer): ParsedImage | undefined {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return parsePng(data);
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) {
    return parseGif(data);
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    return { mediaType: "image/jpeg", ...parseJpeg(data) };
  }
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF") {
    return parseWebp(data);
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parsePng(data: Buffer): ParsedImage {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > data.length) {
      throw new Error("PNG image is damaged or truncated.");
    }
    const type = data.toString("ascii", offset + 4, offset + 8);
    const expectedCrc = data.readUInt32BE(dataEnd);
    const actualCrc = crc32(data.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw new Error("PNG image has an invalid chunk checksum.");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("PNG image has an invalid header.");
      width = data.readUInt32BE(dataStart);
      height = data.readUInt32BE(dataStart + 4);
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new Error("PNG image contains more than one header.");
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("Animated PNG images are not supported.");
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== data.length) {
        throw new Error("PNG image is damaged or contains trailing data.");
      }
      return { mediaType: "image/png", width, height };
    }
    offset = chunkEnd;
  }
  throw new Error("PNG image is damaged or truncated.");
}

function parseGif(data: Buffer): ParsedImage {
  if (data.length < 14) throw new Error("GIF image is damaged or truncated.");
  let width = data.readUInt16LE(6);
  let height = data.readUInt16LE(8);
  const packed = data[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset > data.length) throw new Error("GIF image has a truncated color table.");
  let frameCount = 0;
  while (offset < data.length) {
    const introducer = data[offset];
    offset += 1;
    if (introducer === 0x3b) {
      if (frameCount !== 1 || offset !== data.length) {
        throw new Error("GIF image is damaged, animated, or contains trailing data.");
      }
      return { mediaType: "image/gif", width, height };
    }
    if (introducer === 0x2c) {
      frameCount += 1;
      if (frameCount > 1) throw new Error("Animated GIF images are not supported.");
      if (offset + 9 > data.length) throw new Error("GIF image descriptor is truncated.");
      const left = data.readUInt16LE(offset);
      const top = data.readUInt16LE(offset + 2);
      const frameWidth = data.readUInt16LE(offset + 4);
      const frameHeight = data.readUInt16LE(offset + 6);
      width = Math.max(width, left + frameWidth);
      height = Math.max(height, top + frameHeight);
      const framePacked = data[offset + 8] ?? 0;
      offset += 9;
      if ((framePacked & 0x80) !== 0) {
        offset += 3 * (1 << ((framePacked & 0x07) + 1));
      }
      if (offset >= data.length) throw new Error("GIF image data is truncated.");
      offset += 1;
      offset = skipGifSubBlocks(data, offset);
      continue;
    }
    if (introducer === 0x21) {
      if (offset >= data.length) throw new Error("GIF extension is truncated.");
      const extensionLabel = data[offset];
      offset += 1;
      if (extensionLabel === 0xff && offset < data.length) {
        const blockSize = data[offset] ?? 0;
        const identifier = data.toString("ascii", offset + 1, offset + 1 + blockSize);
        if (identifier === "NETSCAPE2.0" || identifier === "ANIMEXTS1.0") {
          throw new Error("Animated GIF images are not supported.");
        }
      }
      offset = skipGifSubBlocks(data, offset);
      continue;
    }
    throw new Error("GIF image contains an invalid block.");
  }
  throw new Error("GIF image is damaged or truncated.");
}

function skipGifSubBlocks(data: Buffer, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < data.length) {
    const size = data[offset] ?? 0;
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > data.length) throw new Error("GIF image data is truncated.");
    offset += size;
  }
  throw new Error("GIF image data is truncated.");
}

function parseJpeg(data: Buffer): { width: number; height: number } {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let sawScan = false;
  while (offset < data.length) {
    if (data[offset] !== 0xff) throw new Error("JPEG image contains an invalid marker.");
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd8) {
      throw new Error("JPEG image contains an invalid marker.");
    }
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || offset !== data.length) {
        throw new Error("JPEG image is damaged or contains trailing data.");
      }
      return dimensions;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) throw new Error("JPEG image segment is truncated.");
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) {
      throw new Error("JPEG image segment is damaged or truncated.");
    }
    if (startOfFrameMarkers.has(marker)) {
      if (dimensions || segmentLength < 8) {
        throw new Error("JPEG image has an invalid frame header.");
      }
      dimensions = {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
    if (marker === 0xda) {
      sawScan = true;
      offset = findJpegMarkerAfterScan(data, offset);
    }
  }
  throw new Error("JPEG image is damaged or truncated.");
}

function findJpegMarkerAfterScan(data: Buffer, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    if (marker === undefined) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerStart;
  }
  throw new Error("JPEG scan data is truncated.");
}

function parseWebp(data: Buffer): ParsedImage {
  if (data.length < 20 || data.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("WebP image is damaged or truncated.");
  }
  const declaredSize = data.readUInt32LE(4) + 8;
  if (declaredSize !== data.length) {
    throw new Error("WebP image is truncated or contains trailing data.");
  }
  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  while (offset + 8 <= data.length) {
    const kind = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const chunkEnd = payload + size;
    const paddedEnd = chunkEnd + (size & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > data.length) {
      throw new Error("WebP image chunk is damaged or truncated.");
    }
    if (kind === "ANIM" || kind === "ANMF") {
      throw new Error("Animated WebP images are not supported.");
    }
    if (kind === "VP8X") {
      if (canvas || size !== 10) throw new Error("WebP extended header is invalid.");
      if (((data[payload] ?? 0) & 0x02) !== 0) {
        throw new Error("Animated WebP images are not supported.");
      }
      canvas = {
        width: 1 + readUInt24LE(data, payload + 4),
        height: 1 + readUInt24LE(data, payload + 7),
      };
    } else if (kind === "VP8 ") {
      if (
        frame ||
        size < 10 ||
        data[payload + 3] !== 0x9d ||
        data[payload + 4] !== 0x01 ||
        data[payload + 5] !== 0x2a
      ) {
        throw new Error("WebP VP8 frame is invalid.");
      }
      frame = {
        width: data.readUInt16LE(payload + 6) & 0x3fff,
        height: data.readUInt16LE(payload + 8) & 0x3fff,
      };
    } else if (kind === "VP8L") {
      if (frame || size < 5 || data[payload] !== 0x2f) {
        throw new Error("WebP lossless frame is invalid.");
      }
      const b1 = data[payload + 1] ?? 0;
      const b2 = data[payload + 2] ?? 0;
      const b3 = data[payload + 3] ?? 0;
      const b4 = data[payload + 4] ?? 0;
      frame = {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
    offset = paddedEnd;
  }
  if (offset !== data.length || !frame) throw new Error("WebP image is damaged or truncated.");
  if (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) {
    throw new Error("WebP canvas and frame dimensions do not match.");
  }
  return { mediaType: "image/webp", ...(canvas ?? frame) };
}

function readUInt24LE(data: Buffer, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16);
}

async function readRegularFileBounded(
  filePath: string,
  maxBytes: number,
  allowedRoot?: string,
  expectedSize?: number,
): Promise<Buffer> {
  const canonicalBeforeOpen = await realpath(filePath);
  if (allowedRoot) {
    assertPathInside(canonicalBeforeOpen, allowedRoot, "Image path escapes its allowed directory.");
  }
  const handle = await open(canonicalBeforeOpen, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Image path does not refer to a regular file.");
    if (before.size > maxBytes) {
      throw new Error(`Image exceeds the ${formatBytes(maxBytes)} size limit.`);
    }
    if (expectedSize !== undefined && before.size !== expectedSize) {
      throw new Error("Stored image no longer matches its metadata.");
    }
    await assertOpenedPath(
      handle,
      canonicalBeforeOpen,
      before,
      allowedRoot,
      "Image file changed location while it was being opened.",
    );
    const output = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < output.length) {
      const result = await handle.read(output, position, output.length - position, position);
      if (result.bytesRead === 0) throw new Error("Image file was truncated while being read.");
      position += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, output.length);
    const after = await handle.stat();
    if (extraRead.bytesRead !== 0 || !sameStableFile(before, after)) {
      throw new Error("Image file changed while it was being read.");
    }
    return output;
  } finally {
    await handle.close();
  }
}

async function assertOpenedPath(
  handle: FileHandle,
  lexicalPath: string,
  openedInfo: { dev: number; ino: number },
  allowedRoot: string | undefined,
  message: string,
): Promise<void> {
  const directInfo = await lstat(lexicalPath);
  if (directInfo.isSymbolicLink() || !directInfo.isFile() || !sameFileIdentity(openedInfo, directInfo)) {
    throw new Error(message);
  }
  const canonical = await realpath(lexicalPath);
  if (allowedRoot) assertPathInside(canonical, allowedRoot, message);
  const handlePath = await canonicalPathForHandle(handle).catch(() => undefined);
  if (handlePath) {
    if (allowedRoot) assertPathInside(handlePath, allowedRoot, message);
    if (!sameCanonicalPath(handlePath, canonical)) throw new Error(message);
  }
}

async function canonicalPathForHandle(handle: FileHandle): Promise<string | undefined> {
  if (process.platform === "linux") return realpath(`/proc/self/fd/${handle.fd}`);
  return undefined;
}

async function verifyPrivateDirectory(directory: string, label: string): Promise<string> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or junction.`);
  }
  return realpath(directory);
}

function assertPathInside(candidate: string, root: string, message: string): void {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  if (left.ino !== 0 || right.ino !== 0) return left.dev === right.dev && left.ino === right.ino;
  return true;
}

function sameStableFile(
  before: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function extensionForMediaType(mediaType: SupportedImageMediaType): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

function threadDirectoryFor(threadId: string): string {
  return sha256(threadId).slice(0, 32);
}

function storageKeyFromPendingMarkerName(
  threadDirectory: string,
  markerName: string,
): string | undefined {
  if (!THREAD_DIRECTORY_PATTERN.test(threadDirectory) ||
      !markerName.endsWith(PENDING_MARKER_SUFFIX)) return undefined;
  const filename = markerName.slice(0, -PENDING_MARKER_SUFFIX.length);
  if (!STORED_IMAGE_FILENAME_PATTERN.test(filename)) return undefined;
  const storageKey = `attachments/${threadDirectory}/${filename}`;
  return STORAGE_KEY_PATTERN.test(storageKey) ? storageKey : undefined;
}

function normalizeSourceName(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 256);
  return normalized || undefined;
}

function assertThreadId(threadId: string): void {
  if (!/^thread_[A-Za-z0-9_-]{1,128}$/u.test(threadId)) {
    throw new Error("Thread ID is invalid for image attachment storage.");
  }
}

function assertImageLabel(label: string): void {
  if (!IMAGE_LABEL_PATTERN.test(label)) throw new Error("Image label is invalid.");
}

function assertAttachmentMetadata(
  attachment: ImageAttachment,
  maxImageBytes: number,
  maxImageEdge: number,
  maxImagePixels: number,
  threadId?: string,
): void {
  if (!attachment || typeof attachment !== "object") {
    throw new Error("Image attachment metadata is invalid.");
  }
  const keys = Object.keys(attachment);
  const storageMatch = STORAGE_KEY_PATTERN.exec(attachment.storageKey);
  const expectedExtension = isSupportedMediaType(attachment.mediaType)
    ? extensionForMediaType(attachment.mediaType)
    : undefined;
  const pixels = attachment.width * attachment.height;
  if (
    keys.some((key) => !ATTACHMENT_KEYS.has(key)) ||
    !IMAGE_ID_PATTERN.test(attachment.id) ||
    !IMAGE_LABEL_PATTERN.test(attachment.label) ||
    !storageMatch ||
    storageMatch[2] !== attachment.id ||
    storageMatch[3] !== expectedExtension ||
    (threadId !== undefined && storageMatch[1] !== threadDirectoryFor(threadId)) ||
    !/^[a-f0-9]{64}$/u.test(attachment.sha256) ||
    !Number.isInteger(attachment.byteSize) ||
    attachment.byteSize < 1 ||
    attachment.byteSize > maxImageBytes ||
    !Number.isInteger(attachment.width) ||
    !Number.isInteger(attachment.height) ||
    attachment.width < 1 ||
    attachment.height < 1 ||
    attachment.width > maxImageEdge ||
    attachment.height > maxImageEdge ||
    !Number.isSafeInteger(pixels) ||
    pixels > maxImagePixels ||
    (attachment.sourceName !== undefined &&
      (typeof attachment.sourceName !== "string" ||
        attachment.sourceName !== normalizeSourceName(attachment.sourceName)))
  ) {
    throw new Error("Image attachment metadata is invalid.");
  }
}

function isSupportedMediaType(value: unknown): value is SupportedImageMediaType {
  return value === "image/png" || value === "image/jpeg" ||
    value === "image/webp" || value === "image/gif";
}

function safeSum(current: number, value: number, label: string): number {
  const result = current + value;
  if (!Number.isSafeInteger(result)) throw new Error(`The ${label} is unsafe.`);
  return result;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "EEXIST" || error.code === "ENOENT");
}

function emptyGarbageCollectionResult(
  acquiredLock: boolean,
): ImageGarbageCollectionResult {
  return {
    acquiredLock,
    referencedImages: 0,
    committedRecovered: 0,
    orphanImagesRemoved: 0,
    pendingImagesPreserved: 0,
  };
}

function isPendingImageMarker(value: unknown): value is PendingImageMarker {
  if (!isPlainRecord(value)) return false;
  return Object.keys(value).every((key) =>
    ["version", "leaseId", "pid", "storageKey", "createdAt"].includes(key)) &&
    value.version === 1 &&
    typeof value.leaseId === "string" && LEASE_ID_PATTERN.test(value.leaseId) &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.storageKey === "string" && STORAGE_KEY_PATTERN.test(value.storageKey) &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    value.createdAt >= 0;
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
  if (!isPlainRecord(value)) return false;
  return Object.keys(value).every((key) =>
    ["version", "leaseId", "pid", "createdAt"].includes(key)) &&
    value.version === 1 &&
    typeof value.leaseId === "string" && LEASE_ID_PATTERN.test(value.leaseId) &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    value.createdAt >= 0;
}

function isGarbageCollectionLock(value: unknown): value is GarbageCollectionLock {
  if (!isPlainRecord(value)) return false;
  return Object.keys(value).every((key) =>
    ["version", "token", "pid", "createdAt"].includes(key)) &&
    value.version === 1 &&
    typeof value.token === "string" && /^gc_[a-f0-9-]{36}$/u.test(value.token) &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    value.createdAt >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function writeJsonExclusive(
  filePath: string,
  value: unknown,
  allowedRoot: string,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    const serialized = `${JSON.stringify(value)}\n`;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const info = await handle.stat();
    await assertOpenedPath(
      handle,
      filePath,
      info,
      allowedRoot,
      "Private image lifecycle file escaped its expected directory.",
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function readJsonBounded(
  filePath: string,
  allowedRoot: string,
): Promise<unknown> {
  const data = await readRegularFileBounded(filePath, 8 * 1024, allowedRoot);
  try {
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    throw new Error("Private image lifecycle metadata is invalid JSON.");
  }
}

async function safeDirectoryEntries(
  directory: string,
): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    await rmdir(directory);
  } catch (error) {
    if (!isDirectoryNotEmpty(error)) throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function pathExistsAsRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function scanStorageKeys(
  journalPath: string,
  destination: Set<string>,
): Promise<void> {
  const handle = await open(journalPath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Thread journal is not a regular file.");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let carry = "";
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      const text = carry + buffer.subarray(0, result.bytesRead).toString("utf8");
      JOURNAL_STORAGE_KEY_PATTERN.lastIndex = 0;
      for (const match of text.matchAll(JOURNAL_STORAGE_KEY_PATTERN)) {
        const storageKey = match[0];
        if (STORAGE_KEY_PATTERN.test(storageKey)) destination.add(storageKey);
      }
      carry = text.slice(-256);
    }
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function formatBytes(value: number): string {
  return `${Math.ceil(value / (1024 * 1024))} MiB`;
}

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
