import { execa } from "execa";
import os from "node:os";
import path from "node:path";
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type SystemRunner = (program: string, args: string[], cwd?: string) => Promise<CommandResult>;
export const createSystemRunner = (environment: NodeJS.ProcessEnv): SystemRunner => async (program, args, cwd = os.tmpdir()) => {
  const result = await execa(program, args, { cwd, env: environment, extendEnv: false,
    shell: false, windowsHide: true, reject: false, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
};
function maintenanceEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "LOCALAPPDATA", "APPDATA", "ProgramData", "LANG", "LC_ALL"];
  const environment = Object.fromEntries(names.flatMap(name => source[name] ? [[name, source[name]]] : []));
  for (const key of ["PATH", "Path"]) if (environment[key]) environment[key] = environment[key]!.split(path.delimiter)
    .filter(entry => entry && path.isAbsolute(entry.replace(/^"|"$/gu, ""))).join(path.delimiter);
  return environment;
}
export const runSystem: SystemRunner = (program, args, cwd) => createSystemRunner(maintenanceEnvironment())(program, args, cwd);
export async function checked(run: SystemRunner, program: string, args: string[], cwd?: string): Promise<string> {
  const result = await run(program, args, cwd);
  if (result.exitCode !== 0) throw new Error(program + " " + args.slice(0, 2).join(" ") + " failed: " + (result.stderr || result.stdout).slice(-1600));
  return result.stdout.trim();
}
