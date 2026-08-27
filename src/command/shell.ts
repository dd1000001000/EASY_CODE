export type ExplicitShellKind = "cmd" | "powershell" | "posix";

const POSIX_SHELLS = new Set(["sh", "bash", "dash"]);
const POWERSHELL_HOSTS = new Set(["powershell", "pwsh"]);

export interface ShellInvocationInspection {
  kind: ExplicitShellKind;
  valid: boolean;
  reason?: string;
}

export function explicitShellKind(programName: string): ExplicitShellKind | undefined {
  if (programName === "cmd") return "cmd";
  if (POWERSHELL_HOSTS.has(programName)) return "powershell";
  if (POSIX_SHELLS.has(programName)) return "posix";
  return undefined;
}

/** Add non-interactive/profile-safe flags without enabling an implicit Node shell. */
export function normalizeExplicitShellArgs(programName: string, args: readonly string[]): string[] {
  const kind = explicitShellKind(programName);
  if (kind === "cmd") {
    const lowerArgs = args.map((argument) => argument.toLowerCase());
    const commandIndex = lowerArgs.indexOf("/c");
    const hostArgs = commandIndex < 0 ? lowerArgs : lowerArgs.slice(0, commandIndex);
    return hostArgs.includes("/d") ? [...args] : ["/d", ...args];
  }
  if (kind === "powershell") {
    const lowerArgs = args.map((argument) => argument.toLowerCase());
    const commandIndex = lowerArgs.findIndex((argument) =>
      argument === "-command" || argument === "--command" || argument === "-c"
    );
    if (commandIndex < 0) return [...args];
    const prefix = lowerArgs.slice(0, commandIndex);
    const required = ["-NoLogo", "-NoProfile", "-NonInteractive"].filter(
      (flag) => !prefix.includes(flag.toLowerCase()),
    );
    return [...required, ...args];
  }
  return [...args];
}

/** Accept only an explicit, bounded one-shot shell protocol. */
export function inspectExplicitShellInvocation(
  programName: string,
  args: readonly string[],
): ShellInvocationInspection | undefined {
  const kind = explicitShellKind(programName);
  if (!kind) return undefined;
  const lowerArgs = args.map((argument) => argument.toLowerCase());

  if (kind === "cmd") {
    if (lowerArgs.includes("/k")) {
      return { kind, valid: false, reason: "Interactive cmd /k sessions are disabled" };
    }
    const commandIndex = lowerArgs.indexOf("/c");
    if (commandIndex < 0) {
      return { kind, valid: false, reason: "cmd requires an explicit /c command" };
    }
    const allowedPrefix = new Set(["/d", "/s", "/q", "/a", "/u"]);
    if (lowerArgs.slice(0, commandIndex).some((argument) => !allowedPrefix.has(argument))) {
      return { kind, valid: false, reason: "cmd received an unsupported host option before /c" };
    }
    if (!(args[commandIndex + 1]?.trim())) {
      return { kind, valid: false, reason: "cmd /c requires a non-empty command string" };
    }
    return { kind, valid: true };
  }

  if (kind === "powershell") {
    if (lowerArgs.some((argument) =>
      argument === "-encodedcommand" ||
      argument === "--encoded-command" ||
      argument.startsWith("-enc") ||
      argument === "-e"
    )) {
      return { kind, valid: false, reason: "Encoded PowerShell commands are disabled" };
    }
    if (lowerArgs.some((argument) => argument === "-noexit" || argument.startsWith("-noe"))) {
      return { kind, valid: false, reason: "Interactive PowerShell sessions are disabled" };
    }
    const commandIndex = lowerArgs.findIndex((argument) =>
      argument === "-command" || argument === "--command" || argument === "-c"
    );
    if (commandIndex < 0) {
      return { kind, valid: false, reason: "PowerShell requires an explicit -Command invocation" };
    }
    const allowedPrefix = new Set(["-nologo", "-noprofile", "-noninteractive"]);
    if (lowerArgs.slice(0, commandIndex).some((argument) => !allowedPrefix.has(argument))) {
      return { kind, valid: false, reason: "PowerShell received an unsupported host option" };
    }
    if (!(args[commandIndex + 1]?.trim())) {
      return { kind, valid: false, reason: "PowerShell -Command requires a non-empty command string" };
    }
    return { kind, valid: true };
  }

  if (args[0] !== "-c") {
    return {
      kind,
      valid: false,
      reason: "POSIX shells require a non-interactive -c invocation; login and interactive shells are disabled",
    };
  }
  if (!(args[1]?.trim())) {
    return { kind, valid: false, reason: "POSIX shell -c requires a non-empty command string" };
  }
  return { kind, valid: true };
}
