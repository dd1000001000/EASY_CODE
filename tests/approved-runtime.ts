import { AgentRuntime as ProductionAgentRuntime, type AgentRuntimeDependencies } from "../src/runtime/agent.js";

/** Existing Runtime fixtures exercise tool behavior, not interactive permission decisions. */
export class AgentRuntime extends ProductionAgentRuntime {
  constructor(dependencies: AgentRuntimeDependencies) {
    super({
      ...dependencies,
      authorizeToolExecution: dependencies.authorizeToolExecution ??
        (async request => request.binding?.sourceId === "builtin"),
    });
  }
}
