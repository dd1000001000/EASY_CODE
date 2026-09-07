import type { RunCommandInput } from "./types.js";
import { inspectExplicitShellInvocation } from "./shell.js";

const WINDOWS_EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|com)$/iu;
const ASYNC_WORKAROUND_PROGRAMS = new Set(["nohup", "sleep", "timeout"]);

export interface CommandRequestValidationFailure {
  readonly matchedRule:
    | "input.duplicate_program_argument"
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
 * The comparison is deliberately host-independent so Windows paths emitted by
 * a model are rejected consistently even when tests run on another platform.
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
  input: Pick<RunCommandInput, "program" | "args">,
): CommandRequestValidationFailure | undefined {
  const programName = executableBasename(input.program);
  if (hasDuplicateProgramArgument(input)) {
    const asyncRecovery = ASYNC_WORKAROUND_PROGRAMS.has(programName)
      ? (
          " Do not retry this wait/detach program; run the real executable directly with " +
          "structured program and args, using timeoutMs when a bounded synchronous timeout is needed."
        )
      : "";
    return {
      matchedRule: "input.duplicate_program_argument",
      reason:
        "Invalid structured command: args[0] repeats program (or its executable basename). " +
        "The process was not started.",
      recommendation:
        "Keep the executable only in program and remove the duplicate first item from args; " +
        `args must begin with the first real argument.${asyncRecovery}`,
    };
  }

  if (ASYNC_WORKAROUND_PROGRAMS.has(programName)) {
    return {
      matchedRule: "input.async_workaround",
      reason:
        `Direct ${programName} wait/detach commands are disabled because they consume a tool ` +
        "call without managing the real command. The process was not started.",
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
        "Run the real executable directly with structured program and args as one synchronous " +
        "run_command call; use timeoutMs to bound long-running work.",
    };
  }

  return undefined;
}
