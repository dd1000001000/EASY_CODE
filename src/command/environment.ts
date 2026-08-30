import path from "node:path";

const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

export function buildCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
    environment[key] = value;
  }

  // npm's Windows shims may require ComSpec. Do not inherit an arbitrary value;
  // derive the standard executable from the already allowlisted SystemRoot.
  if (process.platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
    if (systemRoot) environment.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
  }

  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.FORCE_COLOR = "0";
  return environment;
}

/**
 * Dangerous mode intentionally runs as the current OS user. Preserve the host
 * environment so proxy, certificate, toolchain, and platform configuration
 * behave exactly as they do in the user's terminal. The enable warning makes
 * clear that child processes can therefore access inherited secrets.
 */
export function buildUnrestrictedCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.NO_COLOR = "1";
  environment.FORCE_COLOR = "0";
  return environment;
}
