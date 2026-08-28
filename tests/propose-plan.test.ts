import assert from "node:assert/strict";

import type { ToolContext } from "../src/core/types.js";
import {
  MAX_PLAN_OVERVIEW_CHARS,
  MAX_PLAN_STEPS,
  MAX_PLAN_TITLE_CHARS,
} from "../src/plans/plan.js";
import { ProposePlanTool } from "../src/tools/propose-plan.js";
import { describe, it } from "./harness.js";

function context(mode: ToolContext["mode"] = "plan"): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode,
    threadId: "thread_propose_plan",
    turnId: "turn_propose_plan",
    approvalPolicy: "never",
    requestApproval: async () => false,
    commandTimeoutMs: 1_000,
    maxOutputChars: 4_000,
  };
}

function validPlan() {
  return {
    title: "Implement login and registration",
    overview: "Add a local demonstration authentication flow without changing the backend.",
    steps: [{
      title: "Add the authentication UI",
      description: "Create login and registration forms and render the current user state.",
      verification: "Open the page and verify both forms and the signed-in user bar.",
    }],
  };
}

describe("propose_plan tool", () => {
  it("returns a sanitized structured draft only in Plan mode", async () => {
    const tool = new ProposePlanTool();
    const input = validPlan();
    input.title = "\u001B[31mImplement login\u001B[0m\u202E";
    input.overview = "Keep api_key=abcdefghijklmnopqrstuvwxyz private.\r\n\r\n\r\nUse local state.";
    input.steps[0]!.description = "Create the UI\u0007 without terminal controls.";

    const result = await tool.execute(input, context());

    assert.equal(tool.mutating, false);
    assert.equal(result.ok, true);
    assert.match(result.planProposal?.title ?? "", /Implement login/u);
    assert.match(result.planProposal?.overview ?? "", /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(result.planProposal?.overview ?? "", /abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(JSON.stringify(result.planProposal), /\u001B|\u202E|\u0007/u);
    assert.deepEqual(result.data, {
      title: result.planProposal?.title,
      stepCount: 1,
    });
  });

  it("rejects use outside Plan mode", async () => {
    const tool = new ProposePlanTool();
    for (const mode of ["auto", "code"] as const) {
      const result = await tool.execute(validPlan(), context(mode));
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /only in Plan mode/u);
      assert.equal(result.planProposal, undefined);
    }
  });

  it("enforces strict fields, visible text, item counts, and field bounds", async () => {
    const tool = new ProposePlanTool();
    const cases: unknown[] = [
      { ...validPlan(), extra: true },
      {
        ...validPlan(),
        steps: [{ ...validPlan().steps[0], extra: true }],
      },
      { ...validPlan(), title: "\u0007" },
      { ...validPlan(), title: "x".repeat(MAX_PLAN_TITLE_CHARS + 1) },
      { ...validPlan(), overview: "x".repeat(MAX_PLAN_OVERVIEW_CHARS + 1) },
      { ...validPlan(), steps: [] },
      {
        ...validPlan(),
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, () => validPlan().steps[0]),
      },
    ];

    for (const candidate of cases) {
      const result = await tool.execute(candidate, context());
      assert.equal(result.ok, false);
      assert.equal(result.planProposal, undefined);
    }
  });

  it("publishes a strict model-facing schema with matching limits", () => {
    const definition = new ProposePlanTool().definition.function;
    assert.equal(definition.name, "propose_plan");
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    const properties = definition.parameters.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.title?.maxLength, MAX_PLAN_TITLE_CHARS);
    assert.equal(properties.overview?.maxLength, MAX_PLAN_OVERVIEW_CHARS);
    assert.equal(properties.steps?.maxItems, MAX_PLAN_STEPS);
  });
});
