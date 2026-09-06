import assert from "node:assert/strict";

import {
  commandCapabilityTimeoutLimitMs,
  formatCommandTimeoutBudget,
  resolveCommandTimeoutBudget,
} from "../src/command/timeout.js";
import { describe, it } from "./harness.js";

describe("command timeout budget", () => {
  it("makes the requested, configured, capability, and effective limits explicit", () => {
    assert.deepEqual(resolveCommandTimeoutBudget(30 * 60_000, 2 * 60_000, "workspace_exec"), {
      requestedMs: 30 * 60_000,
      effectiveMs: 2 * 60_000,
      configuredLimitMs: 2 * 60_000,
      capabilityLimitMs: 15 * 60_000,
    });
    assert.deepEqual(resolveCommandTimeoutBudget(undefined, 2 * 60_000, "safe_inspect"), {
      requestedMs: 2 * 60_000,
      effectiveMs: 60_000,
      configuredLimitMs: 2 * 60_000,
      capabilityLimitMs: 60_000,
    });
  });

  it("uses one capability cap table for every command class", () => {
    assert.equal(commandCapabilityTimeoutLimitMs("safe_inspect"), 60_000);
    assert.equal(commandCapabilityTimeoutLimitMs("registry_install"), 20 * 60_000);
    for (const capability of [
      "workspace_exec",
      "shell_exec",
      "system_write",
      "external_write",
      "destructive",
    ] as const) {
      assert.equal(commandCapabilityTimeoutLimitMs(capability), 15 * 60_000);
    }
  });

  it("renders every limiting value for model-visible command summaries", () => {
    assert.equal(
      formatCommandTimeoutBudget(
        resolveCommandTimeoutBudget(1_800_000, 120_000, "workspace_exec"),
      ),
      "timeout requested=1800000ms, effective=120000ms, " +
        "configured limit=120000ms, capability limit=900000ms",
    );
  });
});
