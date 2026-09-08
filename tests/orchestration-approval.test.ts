import assert from "node:assert/strict";
import { EasyCodeApp } from "../src/app.js";
import type { CommandExecutionMode } from "../src/core/types.js";
import { describe, it } from "./harness.js";

function harness(options: { unfinished?: boolean; outstanding?: boolean; graph?: string; selected?: CommandExecutionMode; mode?: CommandExecutionMode } = {}) {
  const notes: string[] = [], events: unknown[] = [];
  const app = Object.create(EasyCodeApp.prototype);
  Object.assign(app, {
    state: { threadId: "parent", orchestrationEnabled: true, ...(options.graph ? { taskGraph: { status: options.graph } } : {}) },
    config: { orchestrationEnabled: true, approvalPolicy: "safe" }, commandExecutionMode: options.mode ?? "auto_approve", hostAccessEpoch: 0,
    terminal: { selectChoice: async () => options.selected ?? "manual", info: (s: string) => notes.push(s), success: (s: string) => notes.push(s), warning: (s: string) => notes.push(s) },
    subagentCoordinator: { hasUnfinished: () => options.unfinished ?? false, hasOutstanding: () => options.outstanding ?? false, activatePrepared: () => undefined },
    hasRunningCommands: () => false, threadStore: { appendEvent: (_thread: string, event: unknown) => events.push(event) },
    save: () => undefined, syncTerminalView: () => undefined,
  });
  return { app: app as { state: { orchestrationEnabled: boolean }; commandExecutionMode: CommandExecutionMode; selectCommandExecutionMode(): Promise<void>; orchestrationEnabled(): boolean }, notes, events };
}

describe("approval and orchestration transitions", () => {
  it("refuses manual approval while a DAG, child or uncollected assignment remains", async () => {
    for (const options of [{ unfinished: true }, { outstanding: true }, { graph: "active" }, { graph: "paused" }]) {
      const h = harness(options); await h.app.selectCommandExecutionMode();
      assert.equal(h.app.commandExecutionMode, "auto_approve"); assert.equal(h.app.state.orchestrationEnabled, true);
      assert.equal(h.events.length, 0); assert.match(h.notes.join("\n"), /have not finished/);
    }
  });
  it("atomically disables orchestration when manual is selected after work finishes", async () => {
    const h = harness({ graph: "completed" }); await h.app.selectCommandExecutionMode();
    assert.equal(h.app.commandExecutionMode, "manual"); assert.equal(h.app.state.orchestrationEnabled, false);
    assert.equal(h.app.orchestrationEnabled(), false); assert.equal(h.events.length, 1);
  });
  it("manual mode never exposes orchestration even with a stale enabled toggle", () => {
    const h = harness({ mode: "manual" }); assert.equal(h.app.orchestrationEnabled(), false);
  });
  it("switching to an approval agent does not silently reenable a disabled toggle", async () => {
    const h = harness({ mode: "manual", selected: "auto_approve" }); h.app.state.orchestrationEnabled = false;
    await h.app.selectCommandExecutionMode(); assert.equal(h.app.commandExecutionMode, "auto_approve");
    assert.equal(h.app.state.orchestrationEnabled, false);
  });
  it("checks activity again after the selector resolves", async () => {
    const options = { unfinished: false };
    const h = harness(options);
    Object.assign(h.app, { terminal: { selectChoice: async () => { options.unfinished = true; return "manual"; }, info: () => undefined } });
    await h.app.selectCommandExecutionMode(); assert.equal(h.app.commandExecutionMode, "auto_approve"); assert.equal(h.events.length, 0);
  });
});
