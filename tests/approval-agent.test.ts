import assert from "node:assert/strict";
import path from "node:path";
import { reviewCommandApproval, ApprovalQueue } from "../src/command/approval-agent.js";
import { commandGrantPrefix, commandGrantMatches, decodeCommandGrant } from "../src/command/command-grant.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import type { ApprovalRequest, ModelProvider, ModelRequest } from "../src/core/types.js";
import type { ResolvedCommand } from "../src/command/types.js";
import { describe, it } from "./harness.js";

const command: ResolvedCommand = { program: "git", executablePath: path.resolve("/tools/git"), executableHash: "a".repeat(64),
  args: ["status", "--short"], cwdAbsolute: process.cwd(), cwdRelative: ".", executableInsideWorkspace: false,
  environment: {}, environmentKeys: [] };
const request = (): ApprovalRequest => ({ id: "approval", title: "Run git status", description: "Inspect requested project",
  risk: "read", commandPrefix: commandGrantPrefix(command, "workspace", false), commandPreview: "git status --short",
  command: { executable: command.executablePath, args: command.args, cwd: command.cwdAbsolute, scope: "workspace", network: false } });
const provider = (complete: ModelProvider["complete"]): ModelProvider => ({ name: "deepseek", model: "test", complete });

describe("independent approval agent", () => {
  it("accepts all three decisions with a tool-free bounded request and shared usage debit", async () => {
    const budget = new TaskBudget(3, 100000);
    for (const decision of ["allow_once", "allow_prefix", "reject"] as const) {
      let captured: ModelRequest | undefined;
      const result = await reviewCommandApproval(request(), "Inspect project", {
        provider: provider(async input => { captured = input; return { message: { role: "assistant", content: JSON.stringify({ decision, reason: "Evidence checked" }) }, usage: { totalTokens: 50 } }; }),
        budget, maxInputChars: 24000, maxOutputTokens: 512, timeoutMs: 1000,
      });
      assert.equal(result.decision, decision); assert.equal(result.unavailable, undefined);
      assert.equal(captured!.tools, undefined); assert.equal(captured!.thinkingEffort, "none");
      assert.equal(captured!.maxRetries, 0); assert.equal(captured!.maxTokens, 512);
      assert.match(captured!.messages[1]!.content!, /proposedPermission/);
    }
    assert.equal(budget.snapshot().requests, 3); assert.equal(budget.snapshot().tokens, 150);
  });
  it("escalates malformed output, provider errors, timeouts and exhausted budget without retry", async () => {
    for (const complete of [
      async () => ({ message: { role: "assistant" as const, content: '{"decision":"allow_once"}' } }),
      async () => { throw new Error("provider unavailable"); },
      async () => new Promise<never>(() => undefined),
    ]) {
      const result = await reviewCommandApproval(request(), "Inspect", { provider: provider(complete), budget: new TaskBudget(1, 0),
        maxInputChars: 24000, maxOutputTokens: 128, timeoutMs: 20 });
      assert.equal(result.decision, "reject"); assert.equal(result.unavailable, true);
    }
    const exhausted = new TaskBudget(1, 1);
    const result = await reviewCommandApproval(request(), "Inspect", { provider: provider(async () => { throw Error("must not call"); }),
      budget: exhausted, maxInputChars: 24000, maxOutputTokens: 128, timeoutMs: 20 });
    assert.match(result.reason, /budget/); assert.equal(exhausted.snapshot().requests, 0);
  });
  it("does not dispatch oversized or canceled approval evidence", async () => {
    const controller = new AbortController(); controller.abort();
    for (const [req, chars] of [[request(), 10], [{ ...request(), signal: controller.signal }, 24000]] as const) {
      let calls = 0;
      const result = await reviewCommandApproval(req, "inspect", { provider: provider(async () => { calls++; throw Error("unreachable"); }),
        budget: new TaskBudget(1, 0), maxInputChars: chars, maxOutputTokens: 128, timeoutMs: 20 });
      assert.equal(result.unavailable, true); assert.equal(calls, 0);
    }
  });
  it("serializes parent and child requests, including after a rejected operation", async () => {
    const queue = new ApprovalQueue(), order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.run(async () => { order.push("parent"); await gate; throw Error("cancel"); });
    const rejected = assert.rejects(first, /cancel/);
    const second = queue.run(async () => { order.push("child"); return true; });
    await Promise.resolve(); assert.deepEqual(order, ["parent"]);
    release(); await rejected; assert.equal(await second, true); assert.deepEqual(order, ["parent", "child"]);
  });
});

describe("structured command grants", () => {
  it("binds executable bytes, subcommand, cwd, environment scope and network permission", () => {
    const grant = commandGrantPrefix(command, "workspace", false);
    assert.equal(commandGrantMatches(commandGrantPrefix(command, "workspace", true), grant), true);
    assert.equal(commandGrantMatches(grant, commandGrantPrefix({ ...command, args: ["status", "--porcelain"] }, "workspace", false)), true);
    for (const candidate of [commandGrantPrefix(command, "host", false), commandGrantPrefix(command, "workspace", true),
      commandGrantPrefix({ ...command, args: ["push"] }, "workspace", false),
      commandGrantPrefix({ ...command, executableHash: "b".repeat(64) }, "workspace", false),
      commandGrantPrefix({ ...command, cwdRelative: "nested" }, "workspace", false)]) assert.equal(commandGrantMatches(grant, candidate), false);
  });
  it("hashes exact interpreter arguments so grants neither leak secrets nor authorize a different script", () => {
    const inline = { ...command, executablePath: process.execPath, args: ["-e", "const token='private-secret';\nconsole.log(token)"] };
    const grant = commandGrantPrefix(inline, "workspace", false);
    const decoded = decodeCommandGrant(grant);
    assert.equal(decoded.exact, true); assert.doesNotMatch(JSON.stringify(decoded), /private-secret/);
    assert.equal(commandGrantMatches(grant, commandGrantPrefix(inline, "workspace", false)), true);
    assert.equal(commandGrantMatches(grant, commandGrantPrefix({ ...inline, args: ["-e", "console.log('different')"] }, "workspace", false)), false);
  });
});
