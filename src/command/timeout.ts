import type { CommandCapability } from "./types.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

export interface CommandTimeoutBudget {
  /** Background jobs have an independent lifetime instead of a foreground command timeout. */
  kind?: "background";
  /** Per-invocation request, or the configured default when omitted. */
  requestedMs: number;
  /** Wall-clock budget actually applied after every Runtime cap. */
  effectiveMs: number;
  /** Foreground ToolContext ceiling, or independent background lifetime ceiling. */
  configuredLimitMs: number;
  /** Foreground-only safety ceiling selected from the classified command capability. */
  capabilityLimitMs?: number;
}

export function resolveBackgroundCommandTimeoutBudget(
  requestedTimeoutMs: number | undefined,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
): CommandTimeoutBudget {
  const configuredLimitMs = limits.commandBackgroundLifetimeMaxMs;
  const requestedMs = requestedTimeoutMs ?? configuredLimitMs;
  return {
    kind: "background",
    requestedMs,
    effectiveMs: Math.max(1, Math.min(requestedMs, configuredLimitMs)),
    configuredLimitMs,
  };
}

export function commandCapabilityTimeoutLimitMs(capability: CommandCapability, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): number {
  if (capability === "safe_inspect") return limits.commandInspectTimeoutMaxMs;
  if (capability === "registry_install") return limits.commandInstallTimeoutMaxMs;
  return limits.commandExecuteTimeoutMaxMs;
}

export function resolveCommandTimeoutBudget(
  requestedTimeoutMs: number | undefined,
  configuredLimitMs: number,
  capability: CommandCapability,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
): CommandTimeoutBudget {
  const requestedMs = requestedTimeoutMs ?? configuredLimitMs;
  const capabilityLimitMs = commandCapabilityTimeoutLimitMs(capability, limits);
  return {
    requestedMs,
    effectiveMs: Math.max(
      1,
      Math.min(requestedMs, configuredLimitMs, capabilityLimitMs),
    ),
    configuredLimitMs,
    capabilityLimitMs,
  };
}

export function formatCommandTimeoutBudget(timeout: CommandTimeoutBudget): string {
  if (timeout.kind === "background") {
    return (
      `background lifetime requested=${timeout.requestedMs}ms, effective=${timeout.effectiveMs}ms, ` +
      `lifetime limit=${timeout.configuredLimitMs}ms`
    );
  }
  return (
    `timeout requested=${timeout.requestedMs}ms, effective=${timeout.effectiveMs}ms, ` +
    `configured limit=${timeout.configuredLimitMs}ms, ` +
    `capability limit=${timeout.capabilityLimitMs}ms`
  );
}
