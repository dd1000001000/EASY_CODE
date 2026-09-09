import path from "node:path";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { sanitizeCommandOutput, stripTerminalControls } from "./output-stream.js";
import { explicitShellKind, shellCommandWords, literalPipelineCommands } from "./shell.js";
import { sha256 } from "../utils/hash.js";
import type { RunCommandOutput, VerificationKind } from "./types.js";

export interface CommandValidation {
  status: "passed" | "failed" | "unknown";
  confidence: "high" | "low";
  source: "framework_summary" | "process_exit" | "unavailable";
  coverage: "terminal" | "incomplete" | "ambiguous";
  reason: string;
  evidenceKey?: string;
  evidence?: string[];
  targetKey?: string;
  checkKey?: string;
  standard?: { status: "unchanged" | "changed" | "unknown"; baselineDigest: string; changedPaths: string[] };
}

type Framework = "unittest" | "pytest" | "jest" | "node";
type Command = Pick<RunCommandOutput["executed"], "program" | "args"> & { cwd?: string; environmentDigest?: string };

/** Complete selectors remain significant. Only recognized literal display
 * pipelines may share the identity of their first test command. */
export function verificationTargetKey(command: Command): string {
  const pipeline = literalPipelineCommands(command.program, command.args);
  const displayOnly = pipeline && pipeline.length > 1 && framework(pipeline[0]!) &&
    pipeline.slice(1).every(words => ["grep", "rg", "findstr", "head", "tail", "tee"].includes(basename(words[0] ?? "")));
  const words = displayOnly ? pipeline[0]! : [command.program, ...command.args];
  return `sha256:${sha256(JSON.stringify({ words, cwd: command.cwd ?? ".", environment: command.environmentDigest ?? "" }))}`;
}
const MAX_LINE = 8192;
const MAX_CASES = 32;

function basename(value: string): string { return path.basename(value.replace(/\\/gu, "/")).replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase(); }

function framework(words: readonly string[]): Framework | undefined {
  const name = basename(words[0] ?? "");
  const args = words.slice(1);
  if (/^pytest(?:\d+(?:\.\d+)*)?$/u.test(name)) return "pytest";
  if (["jest", "vitest"].includes(name)) return "jest";
  if (name === "node" && args.some(arg => arg === "--test" || arg.startsWith("--test="))) return "node";
  if (/^python(?:\d+(?:\.\d+)*)?$/u.test(name)) {
    if (args[0] === "-m" && args[1] === "pytest") return "pytest";
    if (args[0] === "-m" && args[1] === "unittest" || basename(args[0] ?? "") === "runtests.py" ||
        basename(args[0] ?? "") === "manage.py" && args[1] === "test") return "unittest";
  }
  return undefined;
}

/** Only literal, single-runner package scripts are attributed. No shell is executed here. */
export async function packageScriptRunner(command: Command, cwd: string): Promise<string[] | undefined> {
  if (!["npm", "yarn", "pnpm"].includes(basename(command.program))) return undefined;
  const name = command.args[0] === "run" ? command.args[1] : command.args[0];
  if (!name || name.startsWith("-")) return undefined;
  try {
    const text = await readFile(path.join(cwd, "package.json"), "utf8");
    if (text.length > 1024 * 1024) return undefined;
    const scripts = JSON.parse(text).scripts;
    if (typeof scripts?.[name] !== "string" || scripts[`pre${name}`] || scripts[`post${name}`]) return undefined;
    const commands = literalPipelineCommands("sh", ["-c", scripts[name]]);
    return commands?.length === 1 && framework(commands[0]!) ? commands[0] : undefined;
  } catch { return undefined; }
}

/** Portable logical check identity; environment/version provenance is kept separately. */
export function validationCheckKey(command: Command, workspaceRoot: string): string {
  const normalize = (value: string) => value.replaceAll(workspaceRoot, "<workspace>").replaceAll("\\", "/");
  return verificationTargetKey({ program: normalize(command.program), args: command.args.map(normalize),
    cwd: normalize(command.cwd ?? ".") });
}

function opaque(command: Command): boolean {
  const name = basename(command.program);
  // Pipeline/filter/wrapper exit status alone never proves the target check passed.
  return explicitShellKind(name) !== undefined || ["grep", "rg", "findstr", "tee", "head", "tail", "timeout", "env", "xargs", "powershell", "pwsh"].includes(name);
}

/** Streaming, bounded framework evidence; independent of model-facing head/tail clipping.
 * Repository test output is evidence, not trusted Runtime control or permission.
 */
export class CommandVerificationCollector {
  readonly targetKey: string;
  private readonly streams = ["stdout", "stderr"].map(() => ({ decoder: new StringDecoder("utf8"), pending: "", discard: false }));
  private readonly selected?: Framework;
  private readonly opaque: boolean;
  private readonly cases: string[] = [];
  private readonly caseDigests: string[] = [];
  private specificFailure = false;
  private readonly terminals: Array<{ failed: boolean; text: string }> = [];
  private incomplete = false;
  private ambiguous = false;
  private nodeTests?: number;
  private unittestTests?: number;
  private nodePass?: number;
  private nodeFail?: number;

  constructor(command: Command, packageRunner?: string[]) {
    this.targetKey = verificationTargetKey(command);
    this.opaque = opaque(command);
    const direct = framework(packageRunner ?? [command.program, ...command.args]);
    const runners = direct ? [direct] : shellCommandWords(command.program, command.args).map(framework).filter((value): value is Framework => value !== undefined);
    if (runners.length === 1) this.selected = runners[0];
    else if (runners.length > 1) this.ambiguous = true;
  }

  push(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    if (!this.selected) return;
    const state = this.streams[stream === "stdout" ? 0 : 1]!;
    const decoded = typeof chunk === "string" ? chunk : state.decoder.write(chunk);
    for (const piece of decoded.split(/(?<=\n)/u)) {
      if (!state.discard) {
        state.pending += piece;
        if (state.pending.length > MAX_LINE) { state.discard = true; state.pending = ""; this.incomplete = true; }
      }
      if (piece.endsWith("\n")) {
        if (!state.discard) this.line(state.pending.replace(/[\r\n]+$/u, ""));
        state.pending = ""; state.discard = false;
      }
    }
  }

  private terminal(failed: boolean, text: string): void {
    if (this.terminals.length >= 2) { this.ambiguous = true; return; }
    this.terminals.push({ failed, text: sanitizeCommandOutput(text).slice(0, 512) });
  }

  private failureLine(line: string, specific = false): void {
    if (this.cases.length >= MAX_CASES) { this.incomplete = true; return; }
    const safe = sanitizeCommandOutput(line);
    this.cases.push(safe.slice(0, 256));
    this.caseDigests.push(sha256(safe));
    this.specificFailure ||= specific;
  }

  private line(raw: string): void {
    const line = stripTerminalControls(raw);
    if (/^(?:[A-Za-z_.]*(?:Error|Exception): |E\s+(?:assert |[A-Za-z_.]*(?:Error|Exception): ))/u.test(line)) {
      this.failureLine(line, true);
    }
    if (this.selected === "unittest") {
      const ran = /^Ran (\d+) tests? in \d+(?:\.\d+)?s$/u.exec(line);
      if (ran) {
        if (this.unittestTests !== undefined) this.ambiguous = true;
        this.unittestTests = Number(ran[1]);
      }
      if (/^(?:FAIL|ERROR): \S/u.test(line)) {
        this.failureLine(line);
      }
      if (/^FAILED \((?:(?:failures|errors|skipped|expected failures|unexpected successes)=\d+)(?:, (?:failures|errors|skipped|expected failures|unexpected successes)=\d+)*\)$/u.test(line) &&
          /(?:^FAILED \(|, )(?:failures|errors|unexpected successes)=[1-9]\d*/u.test(line)) this.terminal(true, line);
      if (/^OK(?: \((?:skipped=\d+|expected failures=\d+)(?:, (?:skipped|expected failures)=\d+)*\))?$/u.test(line)) this.terminal(false, line);
    } else if (this.selected === "pytest") {
      if (/^(?:FAILED|ERROR) \S+::\S/u.test(line)) {
        this.failureLine(line, / - (?:assert |[A-Za-z_.]*(?:Error|Exception):)/u.test(line));
      }
      const summary = line.replace(/^=+\s*|\s*=+$/gu, "");
      if (/^(?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+ in \d+(?:\.\d+)?s(?: \([^\n]+\))?$/u.test(summary)) {
        const failed = /\b[1-9]\d* (?:failed|errors?)\b/u.test(summary);
        if (failed || /\b[1-9]\d* passed\b/u.test(summary)) this.terminal(failed, summary.replace(/ in .*$/u, ""));
      }
    } else if (this.selected === "jest") {
      if (/^Test Suites:\s+(?:\d+ (?:failed|passed|skipped),?\s*)+\d+ total\s*$/u.test(line)) {
        const failed = /\b[1-9]\d* failed\b/u.test(line);
        if (failed || /\b[1-9]\d* passed\b/u.test(line)) this.terminal(failed, line);
      }
    } else if (this.selected === "node") {
      if (/^not ok \d+ - /u.test(line)) this.failureLine(line);
      if (/^\s+(?:failureType|error|expected|actual|operator): /u.test(line)) {
        this.failureLine(line.trimStart(), /^\s+(?:error|expected|actual): (?!\|-?$).+/u.test(line));
      }
      const match = /^# (tests|pass|fail) (\d+)$/u.exec(line);
      if (!match) return;
      const key = match[1] === "tests" ? "nodeTests" : match[1] === "pass" ? "nodePass" : "nodeFail";
      if (this[key] !== undefined) this.ambiguous = true;
      this[key] = Number(match[2]);
    }
  }

  finish(status: RunCommandOutput["status"], exitCode: number | null, kind?: VerificationKind): CommandValidation {
    for (const stream of this.streams) {
      const rest = stream.pending + stream.decoder.end();
      if (!stream.discard && rest) this.line(rest);
      stream.pending = "";
    }
    if (this.selected === "node" && this.nodeTests !== undefined && this.nodePass !== undefined && this.nodeFail !== undefined) {
      this.terminal(this.nodeFail > 0, `node tests=${this.nodeTests} pass=${this.nodePass} fail=${this.nodeFail}`);
    }
    const unknown = (reason: string, coverage: CommandValidation["coverage"] = "incomplete"): CommandValidation => ({
      status: "unknown", confidence: "low", source: "unavailable", coverage, reason,
    });
    if (status !== "exited") return unknown("Command did not finish normally; execution status is separate from validation.");
    if (this.ambiguous || this.terminals.length > 1) return unknown("Multiple validation targets or terminal reports cannot be attributed safely.", "ambiguous");
    const terminal = this.terminals[0];
    if (terminal) {
      if (!terminal.failed && (
        this.selected === "unittest" && !(Number(this.unittestTests) > 0) ||
        this.selected === "node" && !(Number(this.nodePass) > 0)
      )) return unknown("No executed passing tests confirmed.");
      // A nonzero outer filter may have failed after a passing test, but the full
      // command is not verified. Do not invent a code failure from that mismatch.
      if (!terminal.failed && exitCode !== 0) return unknown("Passing test summary conflicts with the outer command exit status.", "ambiguous");
      if (this.incomplete) return unknown("Framework evidence exceeded bounded parsing coverage.");
      const evidence = [terminal.text, ...this.cases.sort()];
      return { status: terminal.failed ? "failed" : "passed", confidence: terminal.failed && !this.specificFailure ? "low" : "high", source: "framework_summary", coverage: "terminal",
        reason: `${this.selected} terminal summary`, evidence, evidenceKey: `sha256:${sha256(JSON.stringify([this.selected, terminal.text, this.caseDigests.sort()]))}` };
    }
    if (this.opaque || this.selected) return unknown("No attributable terminal framework result; an outer exit code is not a test verdict.");
    if (!kind || exitCode === null) return unknown("No declared validation target.");
    return { status: exitCode === 0 ? "passed" : "failed", confidence: "high", source: "process_exit", coverage: "terminal",
      reason: "Exit status of the directly invoked, declared validation command (not a parsed test report)." };
  }
}

/** Historical tool results lack streaming evidence; never reinterpret clipped logs as new proof. */
export function legacyCommandValidation(data: { executed?: unknown; exitCode: number | null; stdout?: unknown; stderr?: unknown }): CommandValidation {
  const command = data.executed as Partial<Command> | undefined;
  const unknown = !command || typeof command.program !== "string" || !Array.isArray(command.args) ||
    opaque(command as Command);
  return { status: unknown ? "unknown" : data.exitCode === 0 ? "passed" : "failed", confidence: unknown ? "low" : "high",
    source: unknown ? "unavailable" : "process_exit", coverage: unknown ? "incomplete" : "terminal", reason: "Legacy direct-command exit evidence; no reconstructed framework evidence." };
}
