import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, lstat, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalDecisionResult, LocalDecisionTask } from "./client.js";

const execFileAsync = promisify(execFile);
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const RETAINED_ROTATIONS = 4;
let currentUserSid: Promise<string> | undefined;

async function privateWindowsAcl(target: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  currentUserSid ??= execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"],
    { timeout: 5000, windowsHide: true }).then(result => {
      const sid = result.stdout.match(/S-1-5-\d+(?:-\d+)+/u)?.[0];
      if (!sid) throw new Error("Could not identify the current Windows account for decision traces");
      return sid;
    });
  const sid = await currentUserSid;
  const rights = directory ? "(OI)(CI)F" : "F";
  await execFileAsync("icacls", [target, "/inheritance:r", "/grant:r",
    `*${sid}:${rights}`, "/grant:r", `*S-1-5-18:${rights}`],
  { timeout: 10000, windowsHide: true });
}

async function existingDirectory(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe decision trace directory: ${target}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectory(target: string): Promise<void> {
  if (await existingDirectory(target)) return;
  await mkdir(target, { mode: 0o700 });
  if (!await existingDirectory(target)) throw new Error(`Could not create decision trace directory: ${target}`);
}

/** Keep private decision input logs out of Git without editing project files. */
async function excludeFromGit(projectRoot: string, traceDirectory: string): Promise<void> {
  let repositoryRoot: string;
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"],
      { timeout: 5000, windowsHide: true });
    repositoryRoot = path.resolve(result.stdout.trim());
  } catch {
    return; // A non-Git project has no index from which to exclude traces.
  }
  const relative = path.relative(repositoryRoot, traceDirectory).replace(/\\/gu, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Decision traces are outside the project Git root");
  const result = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"],
    { timeout: 5000, windowsHide: true });
  const exclude = path.resolve(repositoryRoot, result.stdout.trim());
  const pattern = `/${relative}/`;
  const current = await readFile(exclude, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (current.split(/\r?\n/gu).includes(pattern)) return;
  await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`, "utf8");
}

async function rotate(target: string, incomingBytes: number): Promise<void> {
  let currentSize = 0;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe decision trace file");
    currentSize = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (currentSize + incomingBytes <= MAX_TRACE_BYTES) return;
  // A bounded ring: the oldest file is overwritten only within this exact
  // Runtime-owned trace prefix, never in the user's source tree.
  for (let index = RETAINED_ROTATIONS; index >= 1; index -= 1) {
    const previous = index === 1 ? target : `${target}.${index - 1}`;
    try { await stat(previous); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (index === RETAINED_ROTATIONS) {
      const { rm } = await import("node:fs/promises");
      await rm(`${target}.${index}`, { force: true });
    }
    await rename(previous, `${target}.${index}`);
  }
}

export interface LocalDecisionTrace {
  id: string;
  threadId: string;
  turnId: string;
  decision: LocalDecisionResult;
  appliedDecision: string;
  challenged?: boolean;
  challengeAlreadyUsed?: boolean;
}

export interface LocalDecisionFallbackTrace {
  id: string;
  threadId: string;
  turnId: string;
  task: LocalDecisionTask;
  input: string;
  reason: string;
}

async function appendTraceLine(projectRoot: string, threadId: string, record: Record<string, unknown>): Promise<void> {
  if (!/^thread_[a-zA-Z0-9-]+$/u.test(threadId)) throw new Error("Invalid decision trace thread ID");
  const easycode = path.join(projectRoot, ".easycode");
  const directory = path.join(easycode, "decision-traces");
  await ensureDirectory(easycode);
  await ensureDirectory(directory);
  await privateWindowsAcl(directory, true);
  await excludeFromGit(projectRoot, directory);
  const target = path.join(directory, `${threadId}.jsonl`);
  const line = JSON.stringify(record) + "\n";
  await rotate(target, Buffer.byteLength(line));
  await appendFile(target, line, { encoding: "utf8", mode: 0o600 });
  await privateWindowsAcl(target, false);
}

/** Auxiliary project-local audit. The Thread Journal remains authoritative. */
export async function appendLocalDecisionTrace(projectRoot: string, trace: LocalDecisionTrace): Promise<void> {
  await appendTraceLine(projectRoot, trace.threadId, {
    timestamp: new Date().toISOString(), id: trace.id, threadId: trace.threadId,
    turnId: trace.turnId, task: trace.decision.task, input: trace.decision.input,
    inputTokens: trace.decision.inputTokens, truncated: trace.decision.truncated,
    optionOrder: trace.decision.optionOrder, scores: trace.decision.scores,
    decision: trace.decision.decision, modelSha256: trace.decision.modelSha256,
    appliedDecision: trace.appliedDecision,
    device: trace.decision.device,
    submittedToModel: true, fallbackToCloud: false,
    ...(trace.challenged !== undefined ? { challenged: trace.challenged } : {}),
    ...(trace.challengeAlreadyUsed !== undefined ? { challengeAlreadyUsed: trace.challengeAlreadyUsed } : {}),
  });
}

/** A fallback has no Laya choice; retain the attempted input without claiming inference occurred. */
export async function appendLocalDecisionFallbackTrace(projectRoot: string,
  trace: LocalDecisionFallbackTrace): Promise<void> {
  await appendTraceLine(projectRoot, trace.threadId, {
    timestamp: new Date().toISOString(), id: trace.id, threadId: trace.threadId,
    turnId: trace.turnId, task: trace.task, input: trace.input,
    submittedToModel: false, decision: null, optionOrder: null, scores: null,
    fallbackToCloud: trace.task === "route", reason: trace.reason,
  });
}
