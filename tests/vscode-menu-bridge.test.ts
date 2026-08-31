import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

import {
  createVsCodeMenuBridge,
  VSCODE_BRIDGE_ENDPOINT_ENV,
  VSCODE_BRIDGE_TOKEN_ENV,
  VSCODE_DISCLOSURE_TOGGLE_CAPABILITY,
} from "../src/cli/vscode-menu-bridge.js";
import { describe, it } from "./harness.js";

class FakeSocket extends Duplex {
  outgoing = "";

  _read(): void {}

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.outgoing += chunk.toString();
    callback();
  }

  setNoDelay(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  connect(): void {
    this.emit("connect");
  }

  receive(value: unknown): void {
    this.push(`${JSON.stringify(value)}\n`);
  }
}

const TOKEN = "a".repeat(64);

function frames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.outgoing
    .split("\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe("VS Code out-of-band menu navigation", () => {
  it("authenticates, moves only an active selector, and closes its lifecycle", async () => {
    const socket = new FakeSocket();
    const bridge = createVsCodeMenuBridge({
      environment: {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:43123",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      identity: { pid: 321, ppid: 123, cwd: "C:\\workspace" },
      connect: (port) => {
        assert.equal(port, 43123);
        return socket as unknown as Socket;
      },
    });
    assert.ok(bridge);

    socket.connect();
    assert.deepEqual(frames(socket)[0], {
      type: "hello",
      token: TOKEN,
      pid: 321,
      ppid: 123,
      cwd: "C:\\workspace",
      protocol: 2,
      capabilities: [VSCODE_DISCLOSURE_TOGGLE_CAPABILITY],
    });

    const received: string[] = [];
    const activation = bridge.activate((direction) => received.push(direction));
    const menuFrame = frames(socket)[1];
    assert.deepEqual(menuFrame, {
      type: "menu",
      active: true,
      requestId: 1,
    });
    socket.receive({ type: "bridge-ready", protocol: 2 });
    socket.receive({
      type: "menu-ready",
      requestId: menuFrame?.requestId,
      ready: true,
    });
    socket.receive({ type: "navigate", direction: "down" });
    socket.receive({ type: "navigate", direction: "left" });
    socket.receive({ type: "navigate", direction: "up", extra: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await activation.ready, true);
    assert.deepEqual(received, ["down"]);

    activation.release();
    socket.receive({ type: "navigate", direction: "up" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["down"]);
    assert.deepEqual(
      frames(socket)
        .filter((frame) => frame.type === "menu")
        .map((frame) => frame.active),
      [true, false],
    );
    bridge.close();
  });

  it("routes strict disclosure toggles even when no selector is active", async () => {
    const socket = new FakeSocket();
    const bridge = createVsCodeMenuBridge({
      environment: {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:43123",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      identity: { pid: 321, ppid: 123, cwd: "C:\\workspace" },
      connect: () => socket as unknown as Socket,
    });
    assert.ok(bridge);

    const received: Array<{ kind: string; id: number }> = [];
    const release = bridge.onDisclosureToggle((kind, id) => {
      received.push({ kind, id });
    });
    socket.connect();
    socket.receive({ type: "bridge-ready", protocol: 2 });
    socket.receive({ type: "toggle-disclosure", kind: "thinking", id: 7 });
    socket.receive({ type: "toggle-disclosure", kind: "adjustment", id: 3 });
    socket.receive({ type: "toggle-disclosure", kind: "thinking", id: "7" });
    socket.receive({ type: "toggle-disclosure", kind: "thinking", id: 0 });
    socket.receive({
      type: "toggle-disclosure",
      kind: "thinking",
      id: 8,
      extra: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [
      { kind: "thinking", id: 7 },
      { kind: "adjustment", id: 3 },
    ]);

    release();
    socket.receive({ type: "toggle-disclosure", kind: "thinking", id: 9 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(received.length, 2);
    bridge.close();
  });

  it("falls back to Raw TTY when a legacy extension does not acknowledge readiness", async () => {
    const socket = new FakeSocket();
    const bridge = createVsCodeMenuBridge({
      environment: {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:43123",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      identity: { pid: 321, ppid: 123, cwd: "C:\\workspace" },
      connect: () => socket as unknown as Socket,
      legacyFallbackMs: 5,
      readyAckTimeoutMs: 20,
    });
    assert.ok(bridge);
    socket.connect();

    const activation = bridge.activate(() => undefined);
    assert.equal(await activation.ready, false);
    activation.release();
    bridge.close();
  });

  it("does not use the short legacy timeout before the socket connects", async () => {
    const socket = new FakeSocket();
    const bridge = createVsCodeMenuBridge({
      environment: {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:43123",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      identity: { pid: 321, ppid: 123, cwd: "C:\\workspace" },
      connect: () => socket as unknown as Socket,
      legacyFallbackMs: 5,
      readyAckTimeoutMs: 100,
    });
    assert.ok(bridge);

    const activation = bridge.activate(() => undefined);
    const ready = activation.ready;
    assert.ok(ready);
    const beforeConnect = await Promise.race([
      ready.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 15)),
    ]);
    assert.equal(beforeConnect, "pending");

    socket.connect();
    assert.equal(await ready, false);
    activation.release();
    bridge.close();
  });

  it("rejects malformed or non-loopback bridge configuration", () => {
    const connect = (): Socket => {
      throw new Error("must not connect");
    };
    for (const environment of [
      {},
      {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "0.0.0.0:1234",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:70000",
        [VSCODE_BRIDGE_TOKEN_ENV]: TOKEN,
      },
      {
        [VSCODE_BRIDGE_ENDPOINT_ENV]: "127.0.0.1:1234",
        [VSCODE_BRIDGE_TOKEN_ENV]: "not-a-token",
      },
    ]) {
      assert.equal(
        createVsCodeMenuBridge({ environment, connect }),
        undefined,
      );
    }
  });
});
