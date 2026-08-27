import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface EasyCodeInstruction {
  path: string;
  source: "user" | "workspace";
  depth: number;
  content: string;
  truncated: boolean;
}

export interface LoadEasyCodeInstructionsOptions {
  configDir: string;
  workspaceRoot: string;
  cwd: string;
  maxFileBytes?: number;
  maxTotalChars?: number;
  platform?: NodeJS.Platform;
}

interface InstructionCandidate {
  path: string;
  source: "user" | "workspace";
  depth: number;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOTAL_CHARS = 96 * 1024;

/** Load user instructions, then workspace instructions from root towards cwd. */
export async function loadEasyCodeInstructions(
  options: LoadEasyCodeInstructionsOptions,
): Promise<EasyCodeInstruction[]> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const cwd = path.resolve(options.cwd);
  const candidates: InstructionCandidate[] = [
    {
      path: path.join(path.resolve(options.configDir), "EASYCODE.md"),
      source: "user",
      depth: -1,
    },
    ...workspaceCandidates(workspaceRoot, cwd),
  ];
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const platform = options.platform ?? process.platform;
  const discovered: Array<EasyCodeInstruction & { order: number }> = [];
  const seen = new Set<string>();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const loaded = await readInstruction(candidate, {
      workspaceRoot,
      maxFileBytes,
      platform,
    });
    if (!loaded) continue;
    const identity = normalizeIdentity(loaded.path, platform);
    if (seen.has(identity)) continue;
    seen.add(identity);
    discovered.push({ ...loaded, order: index });
  }

  // Preserve user-level guidance, then favor instructions closest to cwd when
  // the chain exceeds its context allowance. The final output remains root-to-cwd.
  const priority = [
    ...discovered.filter((item) => item.source === "user"),
    ...discovered
      .filter((item) => item.source === "workspace")
      .sort((left, right) => right.depth - left.depth),
  ];
  const kept = new Map<number, EasyCodeInstruction>();
  let remaining = maxTotalChars;
  for (const item of priority) {
    if (remaining <= 0) break;
    const content = item.content.slice(0, remaining);
    kept.set(item.order, {
      path: item.path,
      source: item.source,
      depth: item.depth,
      content,
      truncated: item.truncated || content.length < item.content.length,
    });
    remaining -= content.length;
  }

  return [...kept.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, instruction]) => instruction);
}

function workspaceCandidates(
  workspaceRoot: string,
  cwd: string,
): InstructionCandidate[] {
  const relative = path.relative(workspaceRoot, cwd);
  const cwdIsInside =
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
  const directories = [workspaceRoot];
  if (cwdIsInside && relative) {
    let current = workspaceRoot;
    for (const segment of relative.split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      directories.push(current);
    }
  }
  return directories.map((directory, depth) => ({
    path: path.join(directory, "EASYCODE.md"),
    source: "workspace" as const,
    depth,
  }));
}

async function readInstruction(
  candidate: InstructionCandidate,
  options: {
    workspaceRoot: string;
    maxFileBytes: number;
    platform: NodeJS.Platform;
  },
): Promise<EasyCodeInstruction | undefined> {
  let filePath: string;
  try {
    filePath = await realpath(candidate.path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Unable to resolve EASYCODE.md at ${candidate.path}`);
  }

  if (candidate.source === "workspace") {
    let realWorkspace: string;
    try {
      realWorkspace = await realpath(options.workspaceRoot);
    } catch {
      realWorkspace = options.workspaceRoot;
    }
    if (!isWithin(realWorkspace, filePath, options.platform)) return undefined;
  }

  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new Error(`Unable to inspect EASYCODE.md at ${candidate.path}`);
  }
  if (!metadata.isFile()) return undefined;

  const bytesToRead = Math.min(metadata.size, options.maxFileBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(filePath, "r");
  try {
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      path: candidate.path,
      source: candidate.source,
      depth: candidate.depth,
      content: buffer.subarray(0, result.bytesRead).toString("utf8"),
      truncated: metadata.size > bytesToRead,
    };
  } finally {
    await handle.close();
  }
}

function isWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string): string =>
    platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function normalizeIdentity(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
