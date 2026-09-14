/** Trusted Windows script adapter. The Runtime launches this native Node
 * executable inside the selected sandbox, then it forwards the original argv
 * without constructing a shell command string. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

interface LaunchPayload {
  target?: {
    executablePath?: unknown;
    args?: unknown;
    cwdAbsolute?: unknown;
  };
}

const payloadPath = process.env.EASY_CODE_LAUNCH_SPEC;
if (process.platform !== "win32" || !payloadPath) throw new Error("Missing trusted Windows launch payload");
const payload = JSON.parse(await readFile(payloadPath, "utf8")) as LaunchPayload;
const target = payload.target;
if (!target || typeof target.executablePath !== "string" || !path.isAbsolute(target.executablePath) ||
    !Array.isArray(target.args) || !target.args.every(value => typeof value === "string") ||
    typeof target.cwdAbsolute !== "string" || !path.isAbsolute(target.cwdAbsolute)) {
  throw new Error("Invalid trusted Windows launch payload");
}
const extension = path.extname(target.executablePath).toLowerCase();
if (![".cmd", ".bat", ".ps1"].includes(extension)) throw new Error("Unsupported Windows script type");

const environment = { ...process.env };
delete environment.EASY_CODE_LAUNCH_SPEC;
const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
const executablePath = extension === ".ps1"
  ? path.join(systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : target.executablePath;
const args = extension === ".ps1"
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", target.executablePath, ...target.args]
  : target.args;
const result = await execa(executablePath, args, {
  cwd: target.cwdAbsolute,
  env: environment,
  extendEnv: false,
  stdio: ["ignore", "inherit", "inherit"],
  shell: false,
  windowsHide: true,
  reject: false,
  cleanup: false,
});
process.exitCode = result.exitCode ?? 125;
