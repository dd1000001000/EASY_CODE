const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu;

const FORBIDDEN_NPM_OPTIONS = [
  "-g",
  "--global",
  "--location=global",
  "--prefix",
  "--globalconfig",
  "--userconfig",
  "--registry",
  "--script-shell",
  "--foreground-scripts",
  "--dangerously-allow-all-scripts",
];

const FLAGS_WITH_VALUE = new Set(["--workspace", "-w", "--include", "--omit"]);

export interface NpmInstallAnalysis {
  isInstall: boolean;
  valid: boolean;
  reason?: string;
  normalizedArgs: string[];
  packageSpecs: string[];
  runsLifecycleScripts: boolean;
}

function splitPackageSpec(spec: string): { name: string; version: string } | undefined {
  if (
    spec.includes("://") ||
    /^(?:git\+|git:|github:|file:|link:|https?:|ssh:)/iu.test(spec) ||
    spec.endsWith(".tgz") ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("\\") ||
    spec.includes("#") ||
    spec.includes("npm:")
  ) {
    return undefined;
  }

  const separator = spec.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!PACKAGE_NAME.test(name) || !EXACT_VERSION.test(version)) return undefined;
  return { name, version };
}

function hasForbiddenOption(args: readonly string[]): string | undefined {
  for (const argument of args) {
    const lower = argument.toLowerCase();
    const forbidden = FORBIDDEN_NPM_OPTIONS.find(
      (option) => lower === option || lower.startsWith(`${option}=`),
    );
    if (forbidden) return argument;
  }
  return undefined;
}

/** Validate and harden a project-local npm install invocation. */
export function analyzeNpmInstall(args: readonly string[]): NpmInstallAnalysis {
  const commandIndex = args.findIndex((argument) => !argument.startsWith("-"));
  if (commandIndex < 0) {
    return { isInstall: false, valid: false, normalizedArgs: [...args], packageSpecs: [], runsLifecycleScripts: false };
  }
  const command = args[commandIndex]?.toLowerCase();
  if (!command || !["install", "i", "add", "ci"].includes(command)) {
    return { isInstall: false, valid: false, normalizedArgs: [...args], packageSpecs: [], runsLifecycleScripts: false };
  }

  const forbidden = hasForbiddenOption(args);
  if (forbidden) {
    return {
      isInstall: true,
      valid: false,
      reason: `npm option ${forbidden} is not allowed`,
      normalizedArgs: [...args],
      packageSpecs: [],
      runsLifecycleScripts: false,
    };
  }

  const packageSpecs: string[] = [];
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (FLAGS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    packageSpecs.push(argument);
  }

  if (command !== "ci") {
    for (const spec of packageSpecs) {
      if (!splitPackageSpec(spec)) {
        return {
          isInstall: true,
          valid: false,
          reason: `Package ${spec} must be a registry package with an exact version`,
          normalizedArgs: [...args],
          packageSpecs,
          runsLifecycleScripts: !args.includes("--ignore-scripts"),
        };
      }
    }
  } else if (packageSpecs.length > 0) {
    return {
      isInstall: true,
      valid: false,
      reason: "npm ci does not accept package specifications",
      normalizedArgs: [...args],
      packageSpecs,
      runsLifecycleScripts: !args.includes("--ignore-scripts"),
    };
  }

  const normalizedArgs = [...args];
  for (const safeFlag of ["--ignore-scripts", "--no-audit", "--no-fund"] as const) {
    if (!normalizedArgs.includes(safeFlag)) normalizedArgs.push(safeFlag);
  }
  if (packageSpecs.length > 0 && !normalizedArgs.includes("--save-exact")) {
    normalizedArgs.push("--save-exact");
  }

  return {
    isInstall: true,
    valid: true,
    normalizedArgs,
    packageSpecs,
    runsLifecycleScripts: false,
  };
}

