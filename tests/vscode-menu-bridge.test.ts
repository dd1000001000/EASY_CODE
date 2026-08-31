import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

import {
  createVsCodeMenuBridge,
  VSCODE_BRIDGE_ENDPOINT_ENV,
  VSCODE_BRIDGE_TOKEN_ENV,
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
    });

    const received: string[] = [];
    const release = bridge.activate((direction) => received.push(direction));
    socket.receive({ type: "navigate", direction: "down" });
    socket.receive({ type: "navigate", direction: "left" });
    socket.receive({ type: "navigate", direction: "up", extra: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["down"]);

    release();
    socket.receive({ type: "navigate", direction: "up" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["down"]);
    assert.deepEqual(
      frames(socket).slice(1).map((frame) => frame.active),
      [true, false],
    );
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
