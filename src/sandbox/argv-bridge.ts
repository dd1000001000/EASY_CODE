import { spawn, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface TargetPayload {
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
}

interface SpawnDescriptor {
  executablePath: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const SANDBOX_ENVIRONMENT_KEYS = /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE|GIT_SSL_CAINFO|CARGO_HTTP_CAINFO|JAVA_TOOL_OPTIONS|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|SRT_[A-Z0-9_]+)$/u;

function mergedTargetEnvironment(payload: TargetPayload): NodeJS.ProcessEnv {
  const environment = { ...payload.environment };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SANDBOX_ENVIRONMENT_KEYS.test(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

const WINDOWS_SHELL_META = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsShellCommand(value: string): string {
  return value.replace(WINDOWS_SHELL_META, "^$1");
}

function escapeWindowsShellArgument(value: string, doubleEscape: boolean): string {
  // This follows the cmd.exe quoting shape from the MIT-licensed cross-spawn
  // package already distributed through execa: first preserve backslashes
  // around quotes, then quote the whole argument and caret-escape cmd
  // metacharacters. Structured argv data therefore cannot become host shell
  // syntax for a .cmd/.bat shim (notably npm.cmd on Windows).
  let escaped = value.replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/gu, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_SHELL_META, "^$1");
  return doubleEscape ? escaped.replace(WINDOWS_SHELL_META, "^$1") : escaped;
}

function spawnDescriptor(
  executablePath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): SpawnDescriptor {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executablePath)) {
    return { executablePath, args: [...args] };
  }
  const isPackageShim = /node_modules[\\/]+\.bin[\\/]+[^\\/]+\.cmd$/iu.test(executablePath);
  const shellCommand = [
    escapeWindowsShellCommand(path.win32.normalize(executablePath)),
    ...args.map((argument) => escapeWindowsShellArgument(argument, isPackageShim)),
  ].join(" ");
  const systemRoot = environment.ComSpec ?? environment.COMSPEC ??
    path.win32.join(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
  return {
    executablePath: systemRoot,
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

async function runTarget(payload: TargetPayload): Promise<number> {
  const environment = mergedTargetEnvironment(payload);
  const descriptor = spawnDescriptor(payload.executablePath, payload.args, environment);
  const options: SpawnOptions = {
    cwd: payload.cwdAbsolute,
    env: environment,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    windowsVerbatimArguments: descriptor.windowsVerbatimArguments === true,
  };
  return new Promise<number>((resolve, reject) => {
    let subprocess;
    try {
      subprocess = spawn(descriptor.executablePath, descriptor.args, options);
    } catch (error) {
      reject(error);
      return;
    }
    subprocess.once("error", reject);
    subprocess.once("exit", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else resolve(signal ? 128 : 1);
    });
  });
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("Missing EASY CODE sandbox target payload");
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as TargetPayload;
  if (
    !payload ||
    typeof payload.executablePath !== "string" ||
    !Array.isArray(payload.args) ||
    typeof payload.cwdAbsolute !== "string" ||
    !payload.environment ||
    typeof payload.environment !== "object"
  ) {
    throw new Error("Invalid EASY CODE sandbox target payload");
  }
  process.exitCode = await runTarget(payload);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`EASY CODE sandbox target launch failed: ${message}\n`);
  process.exitCode = 127;
});
