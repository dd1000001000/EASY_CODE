import { spawn, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

/** A short message for a user who may be looking at another window. */
export interface AttentionNotice {
  readonly title: string;
  readonly body: string;
}

export interface NotifyPlatform {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Linux running under Windows Subsystem for Linux, where Windows toasts are reachable. */
  readonly wsl: boolean;
}

export interface DesktopCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void; on(event: "error", listener: (error: Error) => void): unknown };

const BEL = "\u0007";
const ST = "\u001B\\";
const MAX_TEXT_CHARS = 180;
/** Identical notices closer together than this are one event (several child approvals at once). */
const REPEAT_WINDOW_MS = 3_000;
/** PowerShell's registered AppUserModelID, so the toast is allowed without installing a shortcut. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** One printable line: no terminal controls, no separators the escape formats use. */
function clean(value: string): string {
  const flat = value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length <= MAX_TEXT_CHARS ? flat : `${flat.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

export function detectWsl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/iu.test(os.release()) || /microsoft/iu.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function currentNotifyPlatform(): NotifyPlatform {
  return { platform: process.platform, env: process.env, wsl: detectWsl() };
}

/**
 * The terminal's own notification escape, for terminals known to show one.
 * Multiplexers swallow unknown OSC messages, so nothing is sent through them.
 */
export function terminalNotificationSequence(notice: AttentionNotice, env: NodeJS.ProcessEnv): string | undefined {
  if (env.TMUX || env.STY) return undefined;
  const title = clean(notice.title);
  const body = clean(notice.body);
  const program = env.TERM_PROGRAM ?? "";
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") {
    return `\u001B]99;i=1:d=0;${title}${ST}\u001B]99;i=1:d=1:p=body;${body}${ST}`;
  }
  if (env.TERM?.startsWith("foot")) {
    return `\u001B]777;notify;${title.replace(/;/gu, ",")};${body.replace(/;/gu, ",")}${ST}`;
  }
  if (program === "iTerm.app" || program === "WezTerm" || program === "ghostty") {
    return `\u001B]9;${title}: ${body}${BEL}`;
  }
  return undefined;
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function windowsToastCommand(notice: AttentionNotice): DesktopCommand {
  const xml =
    `<toast><visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(clean(notice.title))}</text><text>${xmlEscape(clean(notice.body))}</text>` +
    `</binding></visual></toast>`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml.replace(/'/gu, "''")}')`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join("\n");
  // -EncodedCommand takes UTF-16LE Base64, so no quoting survives to the shell.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
  };
}

function appleScriptString(value: string): string {
  return `"${clean(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function notifySendCommand(notice: AttentionNotice, env: NodeJS.ProcessEnv): DesktopCommand | undefined {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY && !env.DBUS_SESSION_BUS_ADDRESS) return undefined;
  return { command: "notify-send", args: ["--app-name=EASY CODE", clean(notice.title), clean(notice.body)] };
}

/**
 * Native desktop notifiers for the operating system the CLI runs on, in the
 * order to try them: each later one is used only if the previous cannot start.
 * WSL prefers a Windows toast (the user's desktop) and falls back to WSLg.
 */
export function desktopNotificationCommands(notice: AttentionNotice, host: NotifyPlatform): DesktopCommand[] {
  if (host.platform === "win32") return [windowsToastCommand(notice)];
  if (host.wsl) {
    const linux = notifySendCommand(notice, host.env);
    return linux ? [windowsToastCommand(notice), linux] : [windowsToastCommand(notice)];
  }
  if (host.platform === "darwin") {
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `display notification ${appleScriptString(notice.body)} with title ${appleScriptString(notice.title)}`,
        ],
      },
    ];
  }
  const linux = notifySendCommand(notice, host.env);
  return linux ? [linux] : [];
}

export function notificationsDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(?:0|off|false|no)$/iu.test(env.EASY_CODE_NOTIFICATIONS?.trim() ?? "");
}

export interface AttentionNotifierOptions {
  readonly host?: NotifyPlatform;
  readonly spawn?: SpawnDetached;
  readonly now?: () => number;
}

/**
 * Tells the user something needs them: a terminal bell, then the terminal's
 * own notification or a desktop notification. Nothing is sent while the
 * terminal reports that it has focus, since the user is already looking.
 */
export class AttentionNotifier {
  private focused: boolean | undefined;
  private last: { readonly key: string; readonly at: number } | undefined;
  private readonly host: NotifyPlatform;
  private readonly spawnDetached: SpawnDetached;
  private readonly now: () => number;

  constructor(
    private readonly write: (text: string) => void,
    options: AttentionNotifierOptions = {},
  ) {
    this.host = options.host ?? currentNotifyPlatform();
    this.spawnDetached = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.now = options.now ?? Date.now;
  }

  /** Focus reports from the terminal (DEC mode 1004); unknown focus counts as away. */
  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  notify(notice: AttentionNotice): boolean {
    if (notificationsDisabled(this.host.env) || this.focused === true) return false;
    const key = `${notice.title}\u0000${notice.body}`;
    const at = this.now();
    if (this.last && this.last.key === key && at - this.last.at < REPEAT_WINDOW_MS) return false;
    this.last = { key, at };

    try {
      this.write(BEL);
      const sequence = terminalNotificationSequence(notice, this.host.env);
      if (sequence) {
        this.write(sequence);
        return true;
      }
    } catch {
      // The terminal may be gone; a desktop notification can still reach the user.
    }
    this.launch(desktopNotificationCommands(notice, this.host));
    return true;
  }

  /** Start the first notifier that exists; a missing one (no interop, no notify-send) falls through. */
  private launch(commands: readonly DesktopCommand[]): void {
    const [command, ...rest] = commands;
    if (!command) return;
    try {
      const child = this.spawnDetached(command.command, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => this.launch(rest));
      child.unref();
    } catch {
      this.launch(rest);
    }
  }
}
