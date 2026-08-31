"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");

const {
  isEasyCodeCommand,
  isEasyCodePackageScript,
  tokenizeCommandLine,
} = require("../lib/command-detection");
const {
  clipboardHasImage,
  parseLinuxClipboardTypes,
  parseMacClipboardInfo,
  parseWindowsClipboardResult,
  resolveExecutable,
} = require("../lib/clipboard");
const {
  chooseTerminalForClient,
  createMenuNavigationServer,
  encodeBridgeFrame,
  isHelloFrame,
  isMenuFrame,
  NdjsonFrameDecoder,
  tokenMatches,
} = require("../lib/menu-navigation-bridge");
const { createTerminalPasteQueue } = require("../lib/paste-command-queue");
const {
  clipboardContainsText,
  createThinkingLinkProvider,
  findThinkingMarkers,
  showThinkingSequence,
  toggleThinkingSequence,
} = require("../extension");

const tests = [];
const test = (name, run) => tests.push({ name, run });

test("recognizes direct and package-manager EASY CODE commands", () => {
  assert.equal(isEasyCodeCommand("easy-code"), true);
  assert.equal(isEasyCodeCommand("easy-code --image ./screen.png"), true);
  assert.equal(isEasyCodeCommand('"C:\\Program Files\\nodejs\\easy-code.cmd"'), true);
  assert.equal(isEasyCodeCommand('& "C:\\Tools\\easy-code.ps1"'), true);
  assert.equal(isEasyCodeCommand("npx --yes easy-code@latest"), true);
  assert.equal(isEasyCodeCommand("npm exec -- easy-code"), true);
  assert.equal(isEasyCodeCommand("pnpm dlx easy-code-agent"), true);
  assert.equal(isEasyCodeCommand("yarn dlx easy-code"), true);
  assert.equal(isEasyCodeCommand("QWEN_API_KEY=secret easy-code"), true);
  assert.equal(isEasyCodeCommand("env QWEN_API_KEY=secret easy-code"), true);
  assert.equal(isEasyCodeCommand("env -i QWEN_API_KEY=secret easy-code"), true);
  assert.equal(isEasyCodeCommand("cross-env QWEN_API_KEY=secret easy-code"), true);
});

test("recognizes package scripts only when they launch EASY CODE", () => {
  assert.equal(
    isEasyCodePackageScript("npm start", {
      name: "sample",
      scripts: { start: "easy-code --mode auto" },
    }),
    true,
  );
  assert.equal(
    isEasyCodePackageScript("npm run agent", {
      name: "sample",
      scripts: { agent: "env QWEN_API_KEY=secret easy-code" },
    }),
    true,
  );
  assert.equal(
    isEasyCodePackageScript("npm start", {
      name: "easy-code-agent",
      scripts: { start: "node dist/index.js" },
    }),
    true,
  );
  assert.equal(
    isEasyCodePackageScript("npm start", {
      name: "sample",
      scripts: { start: "vite" },
    }),
    false,
  );
});

test("does not activate for mentions or similarly named commands", () => {
  assert.equal(isEasyCodeCommand("echo easy-code"), false);
  assert.equal(isEasyCodeCommand("easy-code-helper"), false);
  assert.equal(isEasyCodeCommand("code README-easy-code.md"), false);
  assert.equal(isEasyCodeCommand("npx another-package easy-code"), false);
  assert.equal(isEasyCodeCommand(""), false);
});

test("tokenizes quoted executable paths without losing Windows separators", () => {
  assert.deepEqual(tokenizeCommandLine('"C:\\Program Files\\EASY CODE\\easy-code.cmd" --help'), [
    "C:\\Program Files\\EASY CODE\\easy-code.cmd",
    "--help",
  ]);
});

test("parses Windows clipboard boolean output", () => {
  assert.equal(parseWindowsClipboardResult("True\r\n"), true);
  assert.equal(parseWindowsClipboardResult("False\r\n"), false);
  assert.equal(parseWindowsClipboardResult("warning\ntrue\n"), true);
});

test("parses macOS clipboard image descriptors", () => {
  assert.equal(parseMacClipboardInfo("«class PNGf», 48122, TIFF picture, 92001"), true);
  assert.equal(parseMacClipboardInfo("JPEG picture, 48122"), true);
  assert.equal(parseMacClipboardInfo("Unicode text, 14"), false);
});

test("parses Linux clipboard MIME targets", () => {
  assert.equal(parseLinuxClipboardTypes("text/plain\nimage/png\n"), true);
  assert.equal(parseLinuxClipboardTypes("image/jpeg\ntext/html\n"), true);
  assert.equal(parseLinuxClipboardTypes("text/plain;charset=utf-8\n"), false);
  for (const unsupported of ["image/jpg", "image/bmp", "image/tiff", "image/heic", "image/avif"]) {
    assert.equal(parseLinuxClipboardTypes(`${unsupported}\n`), false);
  }
});

test("prefers native text paste when the clipboard contains text", () => {
  assert.equal(clipboardContainsText("copied source code"), true);
  assert.equal(clipboardContainsText("   "), true);
  assert.equal(clipboardContainsText(""), false);
  assert.equal(clipboardContainsText(undefined), false);
});

test("serializes repeated paste commands for the same terminal", async () => {
  const queue = createTerminalPasteQueue();
  const terminal = {};
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(terminal, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.enqueue(terminal, async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("does not serialize paste commands across different terminals", async () => {
  const queue = createTerminalPasteQueue();
  const firstTerminal = {};
  const secondTerminal = {};
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(firstTerminal, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.enqueue(secondTerminal, async () => {
    events.push("second");
  });

  await second;
  assert.deepEqual(events, ["first:start", "second"]);
  releaseFirst();
  await first;
});

test("continues a terminal paste queue after an earlier command fails", async () => {
  const queue = createTerminalPasteQueue();
  const terminal = {};
  const failure = queue.enqueue(terminal, async () => {
    throw new Error("clipboard probe failed");
  });
  const recovery = queue.enqueue(terminal, async () => "recovered");

  await assert.rejects(failure, /clipboard probe failed/);
  assert.equal(await recovery, "recovered");
});

test("lets a queued paste keep its captured-terminal guard", async () => {
  const queue = createTerminalPasteQueue();
  const firstTerminal = {};
  const secondTerminal = {};
  let activeTerminal = firstTerminal;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const pastedInto = [];

  const first = queue.enqueue(firstTerminal, async () => {
    await firstGate;
  });
  const queued = queue.enqueue(firstTerminal, async () => {
    if (activeTerminal !== firstTerminal) return;
    pastedInto.push(firstTerminal);
  });
  activeTerminal = secondTerminal;
  releaseFirst();

  await Promise.all([first, queued]);
  assert.deepEqual(pastedInto, []);
});

test("decodes fragmented bounded menu bridge frames", () => {
  const decoder = new NdjsonFrameDecoder(128);
  assert.deepEqual(decoder.push('{"type":"menu",'), []);
  assert.deepEqual(decoder.push('"active":true}\n'), [{
    type: "menu",
    active: true,
  }]);
  assert.throws(
    () => new NdjsonFrameDecoder(8).push("123456789"),
    /exceeded its limit/,
  );
  assert.throws(
    () => new NdjsonFrameDecoder(128).push("not-json\n"),
    /not valid JSON/,
  );
});

test("validates authenticated bridge protocol messages", () => {
  const hello = {
    type: "hello",
    token: "a".repeat(64),
    pid: 120,
    ppid: 42,
    cwd: "F:\\project",
  };
  assert.equal(isHelloFrame(hello), true);
  assert.equal(isHelloFrame({ ...hello, ppid: 0 }), false);
  assert.equal(isHelloFrame({ ...hello, cwd: 42 }), false);
  assert.equal(isMenuFrame({ type: "menu", active: true }), true);
  assert.equal(isMenuFrame({ type: "menu", active: "true" }), false);
  assert.equal(tokenMatches(hello.token, "a".repeat(64)), true);
  assert.equal(tokenMatches(hello.token, "b".repeat(64)), false);
  assert.equal(encodeBridgeFrame({ type: "navigate", direction: "up" }),
    '{"type":"navigate","direction":"up"}\n');
});

test("maps bridge clients by parent pid before guarded fallbacks", async () => {
  const first = { processId: Promise.resolve(11) };
  const second = { processId: Promise.resolve(22) };
  const tracked = new Set([first, second]);
  assert.equal(
    await chooseTerminalForClient(
      { ppid: 22 },
      [first, second],
      (terminal) => tracked.has(terminal),
      first,
    ),
    second,
  );
  assert.equal(
    await chooseTerminalForClient(
      { ppid: 99 },
      [first, second],
      (terminal) => tracked.has(terminal),
      first,
    ),
    first,
  );
  assert.equal(
    await chooseTerminalForClient(
      { ppid: 99 },
      [first, second],
      (terminal) => terminal === second,
      first,
    ),
    second,
  );
  assert.equal(
    await chooseTerminalForClient(
      { ppid: 99 },
      [first, second],
      () => false,
      first,
    ),
    undefined,
  );
});

test("uses an authenticated loopback socket for out-of-band navigation", async () => {
  let resolveMenu;
  const menuSeen = new Promise((resolve) => {
    resolveMenu = resolve;
  });
  let observedClient;
  const bridge = createMenuNavigationServer({
    token: "c".repeat(64),
    onMenuState(client, active) {
      observedClient = client;
      resolveMenu(active);
    },
  });
  const endpoint = await bridge.listen();
  const [host, portText] = endpoint.split(":");
  const socket = net.createConnection({ host, port: Number(portText) });
  await once(socket, "connect");
  socket.write(encodeBridgeFrame({
    type: "hello",
    token: bridge.token,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
  }));
  socket.write(encodeBridgeFrame({ type: "menu", active: true }));
  assert.equal(await menuSeen, true);
  const response = once(socket, "data");
  assert.equal(
    bridge.send(observedClient, { type: "navigate", direction: "down" }),
    true,
  );
  assert.equal(
    (await response)[0].toString("utf8"),
    encodeBridgeFrame({ type: "navigate", direction: "down" }),
  );
  socket.destroy();
  bridge.dispose();
});

test("rejects unauthenticated menu bridge clients", async () => {
  let menuUpdates = 0;
  const bridge = createMenuNavigationServer({
    token: "d".repeat(64),
    onMenuState() {
      menuUpdates += 1;
    },
  });
  const endpoint = await bridge.listen();
  const [host, portText] = endpoint.split(":");
  const socket = net.createConnection({ host, port: Number(portText) });
  await once(socket, "connect");
  const closed = once(socket, "close");
  socket.write(encodeBridgeFrame({
    type: "hello",
    token: "wrong-token",
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
  }));
  await closed;
  assert.equal(menuUpdates, 0);
  bridge.dispose();
});

test("uses fixed platform helpers without a shell", async () => {
  const calls = [];
  const hasImage = await clipboardHasImage({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "ignored" },
    runProgram: async (program, args, options) => {
      calls.push({ program, args, options });
      return "true";
    },
  });
  assert.equal(hasImage, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(calls[0].args.includes("-STA"));
  assert.equal(Object.hasOwn(calls[0].options.env, "PATH"), false);
});

test("falls back from Wayland to X11 helper discovery", async () => {
  const calls = [];
  const hasImage = await clipboardHasImage({
    platform: "linux",
    env: { PATH: "/usr/bin", DISPLAY: ":0" },
    resolveExecutable: (name) => `/usr/bin/${name}`,
    runProgram: async (program, args) => {
      calls.push({ program, args });
      if (program.endsWith("wl-paste")) throw new Error("no Wayland display");
      return "image/webp\n";
    },
  });
  assert.equal(hasImage, true);
  assert.deepEqual(
    calls.map((call) => call.program),
    ["/usr/bin/wl-paste", "/usr/bin/xclip"],
  );
});

test("does not resolve a Linux clipboard helper from the workspace", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-code-extension-helper-"));
  try {
    const binary = path.join(root, "wl-paste");
    fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.equal(resolveExecutable("wl-paste", root, [root]), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses only paired EASY CODE thinking markers", () => {
  const line = "prefix ▶ Thinking #42 · 315 chars · /thinking 42 · VS Code Ctrl/Cmd+click to toggle";
  assert.deepEqual(findThinkingMarkers(line), [{
    startIndex: line.indexOf("Thinking #42"),
    length: "Thinking #42".length,
    id: "42",
  }]);

  const expanded = "prefix ↕ Thinking #42 · Ctrl/Cmd+click to close · /thinking 42 suffix";
  assert.deepEqual(findThinkingMarkers(expanded), [{
    startIndex: expanded.indexOf("Thinking #42"),
    length: "Thinking #42".length,
    id: "42",
  }]);

  const compactExpanded = "prefix ↕ Thinking #42 · /thinking 42 suffix";
  assert.deepEqual(findThinkingMarkers(compactExpanded), [{
    startIndex: compactExpanded.indexOf("Thinking #42"),
    length: "Thinking #42".length,
    id: "42",
  }]);

  const legacyExpanded = "prefix ↕ Thinking #42 · Click again to close · /thinking 42 suffix";
  assert.deepEqual(findThinkingMarkers(legacyExpanded), [{
    startIndex: legacyExpanded.indexOf("Thinking #42"),
    length: "Thinking #42".length,
    id: "42",
  }]);

  assert.deepEqual(
    findThinkingMarkers("▶ Thinking #42 · completed · /thinking 43"),
    [],
  );
  assert.deepEqual(
    findThinkingMarkers("Thinking #42 · completed · /thinking 42"),
    [],
  );
  assert.deepEqual(
    findThinkingMarkers("▶ Thinking #042 · completed · /thinking 042"),
    [],
  );
  assert.deepEqual(
    findThinkingMarkers("↕ Thinking #42 · Ctrl/Cmd+click to close · /thinking 43"),
    [],
  );
  assert.deepEqual(
    findThinkingMarkers("↕ Thinking #42 · /thinking 43"),
    [],
  );
  assert.deepEqual(
    findThinkingMarkers("↕ Thinking #42 · click again to close · /thinking 42"),
    [],
    "the expanded control line must use the exact UI-owned form",
  );
});

test("builds a fixed toggle-thinking OSC sequence from numeric IDs", () => {
  assert.equal(
    toggleThinkingSequence("42"),
    "\x1b]6973;easy-code;toggle-thinking;42\x07",
  );
  assert.equal(
    showThinkingSequence("42"),
    "\x1b]6973;easy-code;toggle-thinking;42\x07",
    "the deprecated alias must not retain one-way show behavior",
  );
  assert.throws(() => toggleThinkingSequence("42;echo owned"), TypeError);
  assert.throws(() => toggleThinkingSequence("0"), TypeError);
  assert.throws(() => toggleThinkingSequence("9999999999999999"), TypeError);
  assert.throws(() => toggleThinkingSequence("1".repeat(20)), TypeError);
});

test("thinking links remain scoped to a tracked EASY CODE terminal", () => {
  const terminal = {
    sent: [],
    sendText(text, addNewLine) {
      this.sent.push({ text, addNewLine });
    },
  };
  const enabledTerminals = new Set([terminal]);
  const provider = createThinkingLinkProvider((candidate) =>
    enabledTerminals.has(candidate)
  );
  const line = "▶ Thinking #7 · 315 tokens · /thinking 7";

  const links = provider.provideTerminalLinks(
    { line, terminal },
    { isCancellationRequested: false },
  );
  assert.equal(links.length, 1);
  assert.equal(line.slice(links[0].startIndex, links[0].startIndex + links[0].length), "Thinking #7");
  assert.equal(links[0].tooltip, "Ctrl/Cmd+click to toggle EASY CODE Thinking #7");

  provider.handleTerminalLink(links[0]);
  provider.handleTerminalLink(links[0]);
  assert.deepEqual(terminal.sent, [
    {
      text: "\x1b]6973;easy-code;toggle-thinking;7\x07",
      addNewLine: false,
    },
    {
      text: "\x1b]6973;easy-code;toggle-thinking;7\x07",
      addNewLine: false,
    },
  ], "the same historical marker must toggle on every click");

  const expandedLine = "↕ Thinking #7 · /thinking 7";
  const expandedLinks = provider.provideTerminalLinks(
    { line: expandedLine, terminal },
    { isCancellationRequested: false },
  );
  assert.equal(expandedLinks.length, 1);
  assert.equal(
    expandedLine.slice(
      expandedLinks[0].startIndex,
      expandedLinks[0].startIndex + expandedLinks[0].length,
    ),
    "Thinking #7",
  );
  provider.handleTerminalLink(expandedLinks[0]);
  assert.deepEqual(terminal.sent[2], {
    text: "\x1b]6973;easy-code;toggle-thinking;7\x07",
    addNewLine: false,
  });

  enabledTerminals.delete(terminal);
  provider.handleTerminalLink(links[0]);
  assert.equal(
    terminal.sent.length,
    3,
    "a stale link must be inert after EASY CODE exits",
  );

  provider.handleTerminalLink({ ...links[0] });
  assert.equal(terminal.sent.length, 3, "a forged link object must be inert");
});

test("thinking links recover only after a strict marker proves a pre-existing terminal", () => {
  const terminal = {
    sent: [],
    sendText(text, addNewLine) {
      this.sent.push({ text, addNewLine });
    },
  };
  let enabled = false;
  let recoveries = 0;
  const provider = createThinkingLinkProvider(
    (candidate) => candidate === terminal && enabled,
    (candidate) => {
      if (candidate !== terminal) return false;
      recoveries += 1;
      enabled = true;
      return true;
    },
  );

  assert.deepEqual(
    provider.provideTerminalLinks(
      { line: "ordinary output", terminal },
      { isCancellationRequested: false },
    ),
    [],
  );
  assert.equal(recoveries, 0, "ordinary output must not trigger recovery");

  const links = provider.provideTerminalLinks(
    { line: "▶ Thinking #8 · 25 chars · /thinking 8", terminal },
    { isCancellationRequested: false },
  );
  assert.equal(recoveries, 1);
  assert.equal(links.length, 1);
  provider.handleTerminalLink(links[0]);
  assert.deepEqual(terminal.sent, [{
    text: "\x1b]6973;easy-code;toggle-thinking;8\x07",
    addNewLine: false,
  }]);

  enabled = false;
  provider.handleTerminalLink(links[0]);
  assert.equal(terminal.sent.length, 1, "revocation must make a recovered link inert");
});

test("thinking link provider ignores unrelated terminals and honors cancellation", () => {
  const provider = createThinkingLinkProvider(() => false);
  const context = {
    line: "▶ Thinking #9 · completed · /thinking 9",
    terminal: { sendText: () => assert.fail("must not send") },
  };
  assert.deepEqual(
    provider.provideTerminalLinks(context, { isCancellationRequested: false }),
    [],
  );

  const enabledProvider = createThinkingLinkProvider(() => true);
  assert.deepEqual(
    enabledProvider.provideTerminalLinks(context, { isCancellationRequested: true }),
    [],
  );
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`✗ ${name}\n${error?.stack ?? error}\n`);
    }
  }
  if (failures) process.exitCode = 1;
  else process.stdout.write(`\n${tests.length}/${tests.length} tests passed.\n`);
})();
