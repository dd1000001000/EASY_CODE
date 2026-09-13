import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "../utils/hash.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { checkedPodman, inspectTaskContainer, type PodmanRunner } from "./podman-client.js";
import { podmanResource } from "./podman-startup.js";

export const REVIEW_DEPENDENCY_NAMES = ["node_modules", ".venv", "venv", "dist", "build"] as const;
export interface PodmanReviewSnapshot {
  version: 1; owner: string; generation: string; image: string; revision: string;
  dependencyDigest: string; volumes: Record<string, string>;
}
export class PodmanReviewCleanupError extends Error {}
const digestPattern = /^[a-f0-9]{64}$/u;
export async function writePodmanRecord(filename: string, value: unknown): Promise<void> {
  const staging = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(staging, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(staging, filename); }
  finally { await rm(staging, { force: true }); }
}
export async function validateReviewVolumes(run: PodmanRunner, snapshot: PodmanReviewSnapshot): Promise<void> {
  if (!digestPattern.test(snapshot.owner) || !digestPattern.test(snapshot.revision)) throw new Error("Invalid review snapshot identity");
  for (const [name, volume] of Object.entries(snapshot.volumes)) {
    if (!(REVIEW_DEPENDENCY_NAMES as readonly string[]).includes(name) || !/^easy-code-review-[a-f0-9]{48}$/u.test(volume)) throw new Error("Invalid review dependency volume");
    const values = JSON.parse(await checkedPodman(run, ["volume", "inspect", volume]));
    const labels = values?.[0]?.Labels;
    if (labels?.["io.easy-code.owner"] !== snapshot.owner || labels?.["io.easy-code.review"] !== snapshot.revision)
      throw new Error("Review dependency volume ownership mismatch");
  }
}

/** Caller holds the task's exclusive durable lease throughout this transaction. */
export async function capturePodmanReview(input: {
  run: PodmanRunner; limits: Readonly<RuntimeLimits>; directory: string; owner: string;
  containerName: string; mounts: string[]; signal?: AbortSignal;
}): Promise<PodmanReviewSnapshot> {
  const { run, limits, directory, owner, containerName, mounts, signal } = input;
  const container = await inspectTaskContainer(run, containerName);
  if (container && (container.Config?.Labels?.["io.easy-code.owner"] !== owner || container.State?.Running || container.State?.Paused))
    throw new Error("Review requires an owned, stopped task container");
  const generation = sha256(JSON.stringify([container?.Id ?? limits.podmanImage,
    await readFile(path.join(directory, "environment.revision"), "utf8").catch(() => "initial"), container?.State?.FinishedAt]));
  const cachePath = path.join(directory, "review-snapshot.json");
  let cached: PodmanReviewSnapshot | undefined;
  try {
    const value = JSON.parse(await readFile(cachePath, "utf8"));
    if (value.version === 1 && value.owner === owner && value.generation === generation &&
      /^(?:sha256:)?[a-f0-9]{64}$/u.test(value.image) && digestPattern.test(value.revision)) cached = value;
  } catch { /* Missing/invalid cache is not evidence. */ }
  let image = cached?.image;
  const basePath = path.join(directory, "review-base.json");
  if (!image) {
    try {
      const base = JSON.parse(await readFile(basePath, "utf8"));
      if (base.version === 1 && base.owner === owner && base.generation === generation && /^(?:sha256:)?[a-f0-9]{64}$/u.test(base.image)) image = base.image;
    } catch { /* No completed image snapshot for this generation. */ }
  }
  if (image) {
    const exists = await run(["image", "exists", image]);
    if (exists.exitCode === 1) { image = undefined; cached = undefined; }
    else if (exists.exitCode !== 0) throw new Error("Review image state unknown");
  }
  if (!image) {
    if (container) {
      const id = await checkedPodman(run, ["commit", "--include-volumes=false", containerName,
        `localhost/easy-code-review:${owner.slice(0, 32)}-${generation.slice(0, 16)}`], { timeoutMs: limits.reviewPreparationTimeoutMs, signal });
      if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid immutable review image ID");
      image = id.startsWith("sha256:") ? id : `sha256:${id}`;
    } else {
      const images = JSON.parse(await checkedPodman(run, ["image", "inspect", limits.podmanImage]));
      image = images?.[0]?.Id;
      if (typeof image !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(image)) throw new Error("Invalid base image identity");
    }
  }
  // Persist the completed image separately: a later dependency-budget failure
  // must not pay for another identical commit on every review attempt.
  await writePodmanRecord(basePath, { version: 1, owner, generation, image });
  const script = await readFile(podmanResource("review-dependencies.py"), "utf8");
  const probe = async (volumes: Record<string, string> = {}) => {
    const name = `easy-code-review-probe-${randomUUID()}`;
    try {
      const output = await checkedPodman(run, ["run", "--name", name, "--label", `io.easy-code.owner=${owner}`,
        "--network=none", "--http-proxy=false", "--read-only", "--user", "0:0", "--security-opt=no-new-privileges", "--cap-drop=ALL",
        "--pids-limit", "64", "--memory", `${limits.podmanMemoryMb}m`, "--timeout", String(Math.ceil(limits.reviewPreparationTimeoutMs / 1000)),
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", ...mounts,
        ...Object.entries(volumes).flatMap(([key, volume]) => ["--volume", `${volume}:/snapshot/${key}:rw,nocopy`]),
        "--entrypoint", "python3", image!, "-I", "-c", script, "/workspace", Object.keys(volumes).length ? "/snapshot" : "",
        String(limits.reviewDependencyMaxFiles), String(limits.reviewDependencyMaxBytes), String(limits.reviewPreparationTimeoutMs / 1000)],
      { timeoutMs: limits.reviewPreparationTimeoutMs + limits.podmanControlTimeoutMs, signal });
      const parsed = JSON.parse(output);
      if (!digestPattern.test(parsed.digest) || !Array.isArray(parsed.names) || parsed.names.some((n: string) => !(REVIEW_DEPENDENCY_NAMES as readonly string[]).includes(n)))
        throw new Error("Invalid dependency inventory");
      return parsed as { digest: string; names: string[] };
    } finally {
      try {
        const helper = await inspectTaskContainer(run, name);
        if (helper) {
          if (helper.Config?.Labels?.["io.easy-code.owner"] !== owner) throw new Error("Refusing to remove foreign review helper");
          await checkedPodman(run, ["rm", "--force", name]);
          if (await inspectTaskContainer(run, name)) throw new Error("Review helper cleanup unconfirmed");
        }
      } catch (error) { throw new PodmanReviewCleanupError(`Review helper cleanup unknown: ${String(error)}`); }
    }
  };
  const inventory = await probe();
  if (cached && cached.dependencyDigest === inventory.digest) {
    let present = true;
    for (const volume of Object.values(cached.volumes)) {
      const exists = await run(["volume", "exists", volume]);
      if (exists.exitCode === 1) present = false;
      else if (exists.exitCode !== 0) throw new Error("Review volume state unknown");
    }
    if (present) { await validateReviewVolumes(run, cached); return cached; }
  }
  const revision = sha256(JSON.stringify([1, generation, image, inventory.digest]));
  const volumes: Record<string, string> = {};
  // New names on every failed/incomplete capture; never trust partial volumes.
  const nonce = randomUUID();
  for (const name of inventory.names) {
    const volume = `easy-code-review-${sha256(JSON.stringify([owner, revision, name, nonce])).slice(0, 48)}`;
    await checkedPodman(run, ["volume", "create", "--label", `io.easy-code.owner=${owner}`, "--label", `io.easy-code.review=${revision}`, volume]);
    volumes[name] = volume;
  }
  if (inventory.names.length && (await probe(volumes)).digest !== inventory.digest) throw new Error("Dependencies changed during capture; no review may use this snapshot");
  const snapshot: PodmanReviewSnapshot = { version: 1, owner, generation, image: image!, revision, dependencyDigest: inventory.digest, volumes };
  await writePodmanRecord(cachePath, snapshot);
  return snapshot;
}
