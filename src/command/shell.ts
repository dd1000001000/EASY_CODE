export type ExplicitShellKind = "cmd" | "powershell" | "posix";

const POSIX_SHELLS = new Set(["sh", "bash", "dash"]);
const POWERSHELL_HOSTS = new Set(["powershell", "pwsh"]);

export interface ShellInvocationInspection {
  kind: ExplicitShellKind;
  valid: boolean;
  reason?: string;
}

type ShellLexeme =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string }
  | { readonly kind: "newline"; readonly value: "\n" };

const SHELL_OPERATORS = [
  "&>>",
  "<<<",
  "<<-",
  ";;&",
  "&&",
  "||",
  "|&",
  "&>",
  ">>",
  "<<",
  "<&",
  ">&",
  ">|",
  ";;",
  ";&",
  ";",
  "|",
  "&",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
] as const;

const COMMAND_SEPARATORS = new Set([
  ";",
  ";;",
  ";&",
  ";;&",
  "|",
  "|&",
  "&&",
  "||",
  "&",
  "(",
  ")",
  "{",
  "}",
]);
const REDIRECTION_OPERATORS = new Set(["<", ">", ">>", "<&", ">&", ">|", "&>", "&>>"]);
const HEREDOC_OPERATORS = new Set(["<<", "<<-", "<<<"]);

function isShellWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\v" || character === "\f";
}

/**
 * Tokenize just enough shell syntax to identify process-lifecycle escapes.
 * Quoted/escaped text remains part of its word, so `slee\\p` and `e''val`
 * cannot hide a command, while operators and comments inside strings stay inert.
 */
function lexShellCommand(value: string, kind: ExplicitShellKind): ShellLexeme[] {
  const result: ShellLexeme[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const flushWord = (): void => {
    if (!wordStarted) return;
    result.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;

    if (quote) {
      if (character === quote) {
        // PowerShell escapes a quote inside the same quote style by doubling it.
        if (kind === "powershell" && value[index + 1] === quote) {
          word += quote;
          wordStarted = true;
          index += 1;
        } else {
          quote = undefined;
          wordStarted = true;
        }
        continue;
      }
      const isEscape =
        (kind === "posix" && quote === '"' && character === "\\") ||
        (kind === "powershell" && character === "`") ||
        (kind === "cmd" && character === "^");
      if (isEscape && index + 1 < value.length) {
        if (value[index + 1] === "\r" && value[index + 2] === "\n") index += 2;
        else if (value[index + 1] === "\n") index += 1;
        else {
          word += value[index + 1] as string;
          wordStarted = true;
          index += 1;
        }
        continue;
      }
      word += character;
      wordStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }

    const escapeCharacter = kind === "posix" ? "\\" : kind === "powershell" ? "`" : "^";
    if (character === escapeCharacter && index + 1 < value.length) {
      if (value[index + 1] === "\r" && value[index + 2] === "\n") index += 2;
      else if (value[index + 1] === "\n") index += 1;
      else {
        word += value[index + 1] as string;
        wordStarted = true;
        index += 1;
      }
      continue;
    }

    // POSIX and PowerShell line comments only start at a token boundary.
    if ((kind === "posix" || kind === "powershell") && character === "#" && !wordStarted) {
      while (index + 1 < value.length && value[index + 1] !== "\r" && value[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (kind === "powershell" && character === "<" && value[index + 1] === "#" && !wordStarted) {
      const blockEnd = value.indexOf("#>", index + 2);
      if (blockEnd < 0) break;
      index = blockEnd + 1;
      continue;
    }

    if (character === "\r" || character === "\n") {
      flushWord();
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      result.push({ kind: "newline", value: "\n" });
      continue;
    }
    if (isShellWhitespace(character)) {
      flushWord();
      continue;
    }

    const operator = SHELL_OPERATORS.find((candidate) => value.startsWith(candidate, index));
    if (operator) {
      flushWord();
      result.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }

    word += character;
    wordStarted = true;
  }
  flushWord();
  return result;
}

function executableBasename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
}

function commandSegments(lexemes: readonly ShellLexeme[]): ShellLexeme[][] {
  const result: ShellLexeme[][] = [];
  let current: ShellLexeme[] = [];
  const flush = (): void => {
    if (current.length > 0) result.push(current);
    current = [];
  };
  for (const lexeme of lexemes) {
    if (
      lexeme.kind === "newline" ||
      (lexeme.kind === "operator" && COMMAND_SEPARATORS.has(lexeme.value))
    ) {
      flush();
    } else {
      current.push(lexeme);
    }
  }
  flush();
  return result;
}

function commandWords(segment: readonly ShellLexeme[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const lexeme = segment[index] as ShellLexeme;
    if (
      lexeme.kind === "word" &&
      /^\d+$/u.test(lexeme.value) &&
      segment[index + 1]?.kind === "operator" &&
      REDIRECTION_OPERATORS.has(segment[index + 1]?.value ?? "")
    ) {
      index += 1;
      if (segment[index + 1]?.kind === "word") index += 1;
      continue;
    }
    if (lexeme.kind === "operator" && REDIRECTION_OPERATORS.has(lexeme.value)) {
      if (segment[index + 1]?.kind === "word") index += 1;
      continue;
    }
    if (lexeme.kind === "word") result.push(lexeme.value);
  }
  return result;
}

function posixCommandIndex(words: readonly string[]): number {
  let index = 0;
  const controlWords = new Set(["!", "then", "do", "elif", "else"]);
  while (controlWords.has(words[index]?.toLowerCase() ?? "")) index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;

  while (index < words.length) {
    const command = executableBasename(words[index] as string);
    if (["command", "builtin", "exec", "time", "nice"].includes(command)) {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (command === "env") {
      index += 1;
      while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function hasNestedCommandString(command: string, args: readonly string[]): boolean {
  const name = executableBasename(command);
  if (["sh", "bash", "dash", "zsh", "ksh", "ash", "fish"].includes(name)) {
    return args.some((argument) => /^-[^-]*c[^-]*$/iu.test(argument) || argument === "--command");
  }
  if (["powershell", "pwsh"].includes(name)) {
    return args.some((argument) =>
      ["-c", "-command", "--command", "-encodedcommand", "--encoded-command", "-e"].includes(
        argument.toLowerCase(),
      ),
    );
  }
  return name === "cmd" && args.some((argument) => ["/c", "/k"].includes(argument.toLowerCase()));
}

function asynchronousShellProtocolReason(
  kind: ExplicitShellKind,
  command: string,
): string | undefined {
  const lexemes = lexShellCommand(command, kind);
  if (lexemes.some((lexeme) => lexeme.kind === "operator" && HEREDOC_OPERATORS.has(lexeme.value))) {
    return "Shell heredoc/here-string input is disabled; pass bounded input without another shell parser";
  }
  if (
    (kind === "posix" || kind === "powershell") &&
    lexemes.some((lexeme) => lexeme.kind === "operator" && lexeme.value === "&")
  ) {
    return kind === "powershell"
      ? "PowerShell call/background operators are disabled; run the executable directly with synchronous run_command"
      : "Shell background operators are disabled; run the executable directly with synchronous run_command";
  }

  for (const segment of commandSegments(lexemes)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;

    if (kind === "cmd") {
      const first = words[0]?.toLowerCase() ?? "";
      if (first === "rem" || first.startsWith("::")) continue;
      const name = executableBasename(first);
      if (name === "call") {
        return "Nested cmd CALL dispatch is disabled; run the executable directly";
      }
      if (name === "start") {
        return "Detached cmd start processes are disabled; run the executable directly with synchronous run_command";
      }
      if (name === "timeout" && words.slice(1).some((word) => word.toLowerCase() === "/t")) {
        return "cmd timeout polling is disabled; use timeoutMs on the real synchronous command";
      }
      if (hasNestedCommandString(first, words.slice(1))) {
        return "Nested shell command strings are disabled; use structured program and args";
      }
      continue;
    }

    const commandIndex = kind === "posix" ? posixCommandIndex(words) : 0;
    const commandWord = words[commandIndex];
    if (!commandWord) continue;
    const name = executableBasename(commandWord);
    const args = words.slice(commandIndex + 1);

    if (kind === "posix") {
      if (name === "nohup" || name === "disown") {
        return "Detached nohup/disown processes are disabled; run the executable directly with synchronous run_command";
      }
      if (name === "sleep") {
        return "Shell sleep polling is disabled; run the real command synchronously with timeoutMs when needed";
      }
      if (name === "eval") {
        return "POSIX eval command dispatch is disabled; use structured program and args";
      }
      if (hasNestedCommandString(commandWord, args)) {
        return "Nested shell command strings are disabled; use structured program and args";
      }
      continue;
    }

    if (["start-process", "start", "saps", "start-job", "sajb", "start-threadjob"].includes(name)) {
      return "Detached PowerShell jobs/processes are disabled; run the executable directly with synchronous run_command";
    }
    if (name === "start-sleep" || name === "sleep") {
      return "PowerShell sleep polling is disabled; run the real command synchronously with timeoutMs when needed";
    }
    if (name === "invoke-expression" || name === "iex") {
      return "PowerShell expression dispatch is disabled; use structured program and args";
    }
    if (words.some((word) => word.toLowerCase() === "-asjob")) {
      return "PowerShell -AsJob execution is disabled; run the executable directly with synchronous run_command";
    }
    if (hasNestedCommandString(commandWord, args)) {
      return "Nested shell command strings are disabled; use structured program and args";
    }
  }
  return undefined;
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
    const asynchronousReason = asynchronousShellProtocolReason(
      kind,
      args[commandIndex + 1] as string,
    );
    if (asynchronousReason) return { kind, valid: false, reason: asynchronousReason };
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
    const asynchronousReason = asynchronousShellProtocolReason(
      kind,
      args[commandIndex + 1] as string,
    );
    if (asynchronousReason) return { kind, valid: false, reason: asynchronousReason };
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
  const asynchronousReason = asynchronousShellProtocolReason(kind, args[1] as string);
  if (asynchronousReason) return { kind, valid: false, reason: asynchronousReason };
  return { kind, valid: true };
}
