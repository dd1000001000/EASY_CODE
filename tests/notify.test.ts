import assert from "node:assert/strict";

import {
  AttentionNotifier,
  desktopNotificationCommands,
  terminalNotificationSequence,
  type NotifyPlatform,
  type SpawnDetached,
} from "../src/ui/notify.js";
import { describe, it } from "./harness.js";

const NOTICE = { title: "EASY CODE", body: "Approval needed: npm test" };

function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, wsl = false): NotifyPlatform {
  return { platform, env, wsl };
}

interface Launch {
  readonly command: string;
  readonly args: readonly string[];
}

/** Records launches; the commands named in `missing` fail to start like an absent binary. */
function recordingSpawn(missing: readonly string[] = []): {
  readonly launches: Launch[];
  readonly spawn: SpawnDetached;
} {
  const launches: Launch[] = [];
  const spawn: SpawnDetached = (command, args) => {
    launches.push({ command, args });
    let onError: ((error: Error) => void) | undefined;
    const child = {
      unref: () => undefined,
      on: (_event: "error", listener: (error: Error) => void) => {
        onError = listener;
        return child;
      },
    };
    if (missing.includes(command)) queueMicrotask(() => onError?.(new Error("ENOENT")));
    return child;
  };
  return { launches, spawn };
}

describe("attention notifications", () => {
  it("uses each terminal's own notification escape, and none inside a multiplexer", () => {
    assert.equal(
      terminalNotificationSequence(NOTICE, { TERM_PROGRAM: "iTerm.app" }),
      "\u001B]9;EASY CODE: Approval needed: npm test\u0007",
    );
    assert.match(
      terminalNotificationSequence(NOTICE, { KITTY_WINDOW_ID: "1" }) ?? "",
      /^\u001B\]99;i=1:d=0;EASY CODE/u,
    );
    assert.match(terminalNotificationSequence(NOTICE, { TERM: "foot" }) ?? "", /^\u001B\]777;notify;EASY CODE;/u);
    assert.equal(terminalNotificationSequence(NOTICE, { TERM_PROGRAM: "WezTerm", TMUX: "/tmp/tmux" }), undefined);
    assert.equal(terminalNotificationSequence(NOTICE, { TERM_PROGRAM: "vscode" }), undefined);
    assert.equal(terminalNotificationSequence(NOTICE, { WT_SESSION: "x" }), undefined);
  });

  it("strips control characters so a message cannot inject terminal sequences", () => {
    const sequence = terminalNotificationSequence(
      { title: "EASY CODE", body: "evil\u0007\u001B]52;c;payload\u0007 text" },
      { TERM_PROGRAM: "ghostty" },
    );
    assert.equal(sequence, "\u001B]9;EASY CODE: evil ]52;c;payload text\u0007");
  });

  it("picks a desktop notifier for every operating system", () => {
    const [windows] = desktopNotificationCommands(NOTICE, host("win32"));
    assert.equal(windows?.command, "powershell.exe");
    const script = Buffer.from(windows!.args.at(-1)!, "base64").toString("utf16le");
    assert.match(script, /ToastNotificationManager/u);
    assert.match(script, /Approval needed: npm test/u);
    assert.equal(windows!.args.includes("-ExecutionPolicy"), false);

    const [mac] = desktopNotificationCommands({ title: 'Say "hi"', body: "a\\b" }, host("darwin"));
    assert.deepEqual(mac, {
      command: "osascript",
      args: ["-e", 'display notification "a\\\\b" with title "Say \\"hi\\""'],
    });

    assert.deepEqual(desktopNotificationCommands(NOTICE, host("linux", { DISPLAY: ":0" })), [
      { command: "notify-send", args: ["--app-name=EASY CODE", "EASY CODE", "Approval needed: npm test"] },
    ]);
    assert.deepEqual(desktopNotificationCommands(NOTICE, host("linux")), []);
    assert.deepEqual(
      desktopNotificationCommands(NOTICE, host("linux", { WAYLAND_DISPLAY: "wayland-0" }, true)).map(
        (command) => command.command,
      ),
      ["powershell.exe", "notify-send"],
    );
  });

  it("escapes XML and PowerShell quoting in Windows toasts", () => {
    const [toast] = desktopNotificationCommands({ title: "A & B", body: "it's <done>" }, host("win32"));
    const script = Buffer.from(toast!.args.at(-1)!, "base64").toString("utf16le");
    assert.match(script, /A &amp; B/u);
    assert.match(script, /it''s &lt;done&gt;/u);
  });

  it("rings the bell and stays quiet while the terminal has focus", () => {
    const written: string[] = [];
    const { launches, spawn } = recordingSpawn();
    const notifier = new AttentionNotifier((text) => written.push(text), { host: host("win32"), spawn });
    notifier.setFocused(true);
    assert.equal(notifier.notify(NOTICE), false);
    assert.deepEqual(written, []);

    notifier.setFocused(false);
    assert.equal(notifier.notify(NOTICE), true);
    assert.deepEqual(written, ["\u0007"]);
    assert.equal(launches.length, 1);
  });

  it("sends the terminal escape instead of a desktop notification when the terminal has one", () => {
    const written: string[] = [];
    const { launches, spawn } = recordingSpawn();
    const notifier = new AttentionNotifier((text) => written.push(text), {
      host: host("darwin", { TERM_PROGRAM: "iTerm.app" }),
      spawn,
    });
    notifier.notify(NOTICE);
    assert.deepEqual(written, ["\u0007", "\u001B]9;EASY CODE: Approval needed: npm test\u0007"]);
    assert.equal(launches.length, 0);
  });

  it("merges repeats, honours the off switch, and falls through to the next notifier", async () => {
    let now = 0;
    const { launches, spawn } = recordingSpawn(["powershell.exe"]);
    const notifier = new AttentionNotifier(() => undefined, {
      host: host("linux", { DISPLAY: ":0" }, true),
      spawn,
      now: () => now,
    });
    assert.equal(notifier.notify(NOTICE), true);
    assert.equal(notifier.notify(NOTICE), false);
    now = 5_000;
    assert.equal(notifier.notify(NOTICE), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      launches.map((launch) => launch.command),
      ["powershell.exe", "powershell.exe", "notify-send", "notify-send"],
    );

    const off = new AttentionNotifier(() => assert.fail("must not write"), {
      host: host("win32", { EASY_CODE_NOTIFICATIONS: "off" }),
      spawn: () => assert.fail("must not spawn"),
    });
    assert.equal(off.notify(NOTICE), false);
  });
});
