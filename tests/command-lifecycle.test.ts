import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  terminateProcessTree,
  type KillableSubprocess,
} from "../src/command/lifecycle.js";
import { describe, it } from "./harness.js";

interface FakeTaskkill extends EventEmitter {
  killSignals: Array<NodeJS.Signals | number | undefined>;
  kill(signal?: NodeJS.Signals | number): boolean;
}

function hangingTaskkill(): FakeTaskkill {
  const child = new EventEmitter() as FakeTaskkill;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
}

describe("command process lifecycle", () => {
  it("bounds a hung Windows taskkill helper and falls back to the direct child", async () => {
    const helper = hangingTaskkill();
    const taskkillCalls: string[][] = [];
    const spawnTaskkill = ((_program: string, args: readonly string[]) => {
      taskkillCalls.push([...args]);
      return helper as unknown as ChildProcess;
    }) as typeof spawn;
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    const subprocess: KillableSubprocess = {
      pid: 12_345,
      killed: false,
      kill: (signal) => {
        directSignals.push(signal);
      },
    };

    const startedAt = Date.now();
    await terminateProcessTree(subprocess, 1_500, {
      platform: "win32",
      spawnTaskkill,
      taskkillTimeoutMs: 20,
    });

    assert.ok(Date.now() - startedAt < 500, "termination did not settle after helper timeout");
    assert.deepEqual(taskkillCalls, [["/PID", "12345", "/T", "/F"]]);
    assert.deepEqual(helper.killSignals, ["SIGKILL"]);
    assert.deepEqual(directSignals, ["SIGTERM"]);
  });

  it("settles even when stopping the hung taskkill helper throws", async () => {
    const helper = hangingTaskkill();
    helper.kill = () => {
      throw new Error("helper kill failed");
    };
    const spawnTaskkill = (() => helper as unknown as ChildProcess) as typeof spawn;
    let directKillCount = 0;

    await terminateProcessTree(
      {
        pid: 54_321,
        killed: false,
        kill: () => {
          directKillCount += 1;
        },
      },
      1_500,
      {
        platform: "win32",
        spawnTaskkill,
        taskkillTimeoutMs: 10,
      },
    );

    assert.equal(directKillCount, 1);
  });
});
