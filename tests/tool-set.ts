import type { AgentTool } from "../src/core/types.js";
import {
  bindBuiltinToolMetadata,
  isBuiltinToolName,
} from "../src/tools/capabilities.js";
import {
  snapshotToolSet as snapshotRegisteredToolSet,
  type ToolCatalogSnapshot,
} from "../src/tools/catalog.js";

/** Build the same current-protocol snapshot produced by BuiltinToolSource. */
export function snapshotToolSet(
  tools: readonly AgentTool[],
  revision = 1,
): ToolCatalogSnapshot {
  const registered = tools.map((tool) =>
    tool.metadata || !isBuiltinToolName(tool.name)
      ? tool
      : bindBuiltinToolMetadata(tool));
  return snapshotRegisteredToolSet(registered, revision);
}
