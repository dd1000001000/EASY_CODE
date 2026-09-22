import { createHash } from "node:crypto";
import type { AgentTool } from "../core/types.js";
import type { ToolCatalogBinding } from "./catalog.js";
import { toolMetadata } from "./capabilities.js";

export interface ToolApprovalIdentity {
  readonly key: string;
  readonly label: string;
  readonly input: unknown;
  readonly effects: readonly string[];
  readonly description: string;
}

/** Bind a reusable grant to the concrete operation and the catalog contract, never a dispatcher alone. */
export function toolApprovalIdentity(
  tool: Readonly<AgentTool>, input: unknown, binding: Readonly<ToolCatalogBinding> | undefined,
  workspaceRoot: string,
): ToolApprovalIdentity {
  if (!binding) throw new Error(`Tool ${tool.name} has no catalog binding for approval`);
  const metadata = toolMetadata(tool);
  const target = tool.approvalTarget?.(input);
  if (target && (!target.name || !target.label || /[\u0000-\u001F\u007F]/u.test(target.label))) {
    throw new Error(`Tool ${tool.name} has an invalid approval target`);
  }
  const label = (target?.label ?? metadata.identity.displayName).slice(0, 256);
  const scope = JSON.stringify({
    workspaceRoot,
    toolId: binding.toolId,
    sourceId: binding.sourceId,
    sourceVersion: target?.contractHash ?? binding.sourceVersion ?? null,
    schemaHash: binding.schemaHash,
    metadataHash: binding.metadataHash,
    operation: target?.name ?? tool.name,
  });
  return {
    key: `sha256:${createHash("sha256").update(scope).digest("hex")}`,
    label,
    input: target && "input" in target ? target.input : input,
    effects: metadata.effects,
    description: (target?.description ?? tool.definition.function.description ?? "").slice(0, 1000),
  };
}

export function validateToolApprovalGrants(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) =>
    typeof item === "string" && /^sha256:[a-f0-9]{64}$/u.test(item))) {
    throw new Error("Invalid tool approval grants");
  }
  return [...new Set(value)];
}
