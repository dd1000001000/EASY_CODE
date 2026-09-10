import { lstatSync } from "node:fs";
import path from "node:path";

export interface CommandLocation {
  directory: string;
  launchers: string[];
}

export interface InstallPathDiagnostics {
  nodeExecutable: string;
  npm: CommandLocation[];
  easyCode: CommandLocation[];
  multipleNpmLocations: boolean;
  conflictingEasyCodeLocations: boolean;
}

interface InstallPathDiagnosticOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  isFile?: (filename: string) => boolean;
}

function normalizedDirectory(directory: string, platform: NodeJS.Platform): string {
  const normalized = path.resolve(directory);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function executableNames(base: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [base, `${base}.cmd`, `${base}.ps1`] : [base];
}

function defaultIsFile(filename: string): boolean {
  try {
    return lstatSync(filename).isFile();
  } catch {
    return false;
  }
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function commandLocations(
  command: string,
  options: Required<Pick<InstallPathDiagnosticOptions, "env" | "platform" | "isFile">>,
): CommandLocation[] {
  const observed = new Map<string, CommandLocation>();
  for (const rawEntry of pathValue(options.env).split(path.delimiter)) {
    const trimmed = rawEntry.trim();
    const directory = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (!directory || !path.isAbsolute(directory)) continue;
    const key = normalizedDirectory(directory, options.platform);
    let location = observed.get(key);
    for (const name of executableNames(command, options.platform)) {
      const candidate = path.join(directory, name);
      if (!options.isFile(candidate)) continue;
      if (!location) {
        location = { directory: path.resolve(directory), launchers: [] };
        observed.set(key, location);
      }
      if (!location.launchers.includes(candidate)) location.launchers.push(candidate);
    }
  }
  return [...observed.values()];
}

/** Read-only PATH inspection used after npm reports an existing global shim. */
export function inspectInstallPaths(
  options: InstallPathDiagnosticOptions = {},
): InstallPathDiagnostics {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const shared = { env, platform, isFile };
  const npm = commandLocations("npm", shared);
  const easyCode = commandLocations("easy-code", shared);
  return {
    nodeExecutable: path.resolve(options.nodeExecutable ?? process.execPath),
    npm,
    easyCode,
    multipleNpmLocations: npm.length > 1,
    conflictingEasyCodeLocations: easyCode.length > 1,
  };
}
