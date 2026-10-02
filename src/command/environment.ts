import path from "node:path";

/** Sandbox commands get only these. Proxy variables are omitted because the sandbox
 * routes traffic through its own per-command broker. */
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
  // Windows system description read by build tools (MSBuild, node-gyp, Python, .NET).
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "SYSTEMDRIVE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
  "PSMODULEPATH",
  // POSIX identity.
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Toolchain locations. These name installations, never credentials.
  "JAVA_HOME",
  "GRADLE_HOME",
  "GRADLE_USER_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "GOROOT",
  "GOPATH",
  "GOBIN",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "PYENV_ROOT",
  "PYENV_VERSION",
  "NVM_DIR",
  "NVM_BIN",
  "VOLTA_HOME",
  "FNM_DIR",
  "PNPM_HOME",
  "BUN_INSTALL",
  "DENO_DIR",
  "DOTNET_ROOT",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_NDK_HOME",
  "FLUTTER_ROOT",
  "VCPKG_ROOT",
  // Custom certificate authorities, required behind TLS-inspecting networks.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

/** Names that hold credentials. Matched against underscore-separated words of the variable name. */
const SECRET_NAME =
  /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|PRIVATE|SESSION|COOKIE|AUTH)(?:_|$)/iu;
/** Local agent and session endpoints whose names look like credentials (git over SSH, signing, keyrings). */
const HOST_AGENT_KEYS = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_ID",
  "XDG_SESSION_TYPE",
]);
const URL_CREDENTIALS = /:\/\/[^\s/:@]+:[^\s/@]+@/u;

export interface CommandEnvironmentOptions {
  /** Host execution inherits the user's environment except credentials and EASY CODE internals. */
  readonly host?: boolean;
  /** Names the user configured to forward unconditionally. */
  readonly passthrough?: readonly string[];
}

function hostInheritable(key: string, value: string): boolean {
  const upper = key.toUpperCase();
  if (upper.startsWith("EASY_CODE_")) return false;
  if (HOST_AGENT_KEYS.has(upper)) return true;
  return !SECRET_NAME.test(upper) && !URL_CREDENTIALS.test(value);
}

export function buildCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: CommandEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const passthrough = new Set((options.passthrough ?? []).map((key) => key.toUpperCase()));
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (
      SAFE_ENVIRONMENT_KEYS.has(upper) ||
      passthrough.has(upper) ||
      (options.host === true && hostInheritable(key, value))
    )
      environment[key] = value;
  }

  // npm's Windows shims may require ComSpec. Do not inherit an arbitrary value;
  // derive the standard executable from the already allowlisted SystemRoot.
  if (process.platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
    if (systemRoot) {
      for (const key of Object.keys(environment)) if (key.toUpperCase() === "COMSPEC") delete environment[key];
      environment.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
    }
  }

  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.FORCE_COLOR = "0";
  return environment;
}
