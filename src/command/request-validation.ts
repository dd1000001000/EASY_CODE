import type { RunCommandInput } from "./types.js";
import { inspectExplicitShellInvocation } from "./shell.js";

const WINDOWS_EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|com)$/iu;
const DETACHED_PROGRAMS = new Set(["nohup", "disown"]);

export interface CommandRequestValidationFailure {
  readonly matchedRule:
    | "input.async_workaround"
    | "input.shell_protocol";
  readonly reason: string;
  readonly recommendation: string;
}

function normalizePathLikeExecutable(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/gu, "").toLowerCase();
}

function executableBasename(value: string): string {
  const normalized = normalizePathLikeExecutable(value);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(WINDOWS_EXECUTABLE_EXTENSION, "");
}

/**
 * Detect the common structured-argv mistake where the executable is supplied
 * in both `program` and `args[0]` (for example `sleep`, `["sleep", "5"]`).
 * This is advisory only: `python python` can legitimately run a script named python.
 */
export function hasDuplicateProgramArgument(
  input: Pick<RunCommandInput, "program" | "args">,
): boolean {
  const firstArgument = input.args?.[0];
  if (!firstArgument) return false;

  const program = normalizePathLikeExecutable(input.program);
  const argument = normalizePathLikeExecutable(firstArgument);
  if (program === argument) return true;

  return executableBasename(program) === executableBasename(argument);
}

/** Validate mistakes that must be rejected before resolution, approval, or spawn. */
export function validateCommandRequest(
  input: Pick<RunCommandInput, "program" | "args"> &
    Partial<Pick<RunCommandInput, "intent" | "verificationKind">>,
): CommandRequestValidationFailure | undefined {
  const programName = executableBasename(input.program);
  if (DETACHED_PROGRAMS.has(programName)) {
    return {
      matchedRule: "input.async_workaround",
      reason:
        `Direct ${programName} detached commands are unsupported. The process was not started.`,
      recommendation:
        "Run the real executable directly with structured program and args, using timeoutMs " +
        "when a bounded synchronous timeout is needed.",
    };
  }

  const shellInspection = inspectExplicitShellInvocation(programName, input.args ?? []);
  if (shellInspection && !shellInspection.valid) {
    return {
      matchedRule: "input.shell_protocol",
      reason: `${shellInspection.reason ?? "Unsupported shell protocol"}. The process was not started.`,
      recommendation:
        shellInspection.reason === "cmd /c accepts exactly one structured command-string argument"
          ? 'For directory listing use search_files with mode="list". Otherwise pass the entire cmd command as ONE argument after /c, for example program="cmd", args=["/c", "dir /b"], cwd=".". This corrects argument shape only; normal policy and approval still apply.'
          : "Run the real executable directly with structured program and args as one synchronous " +
        "run_command call; use timeoutMs to bound long-running work.",
    };
  }

  return undefined;
}
