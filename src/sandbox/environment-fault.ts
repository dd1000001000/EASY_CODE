/** A host-owned stop condition, not a model/argument error. Never retry it. */
export class CommandEnvironmentQuarantined extends Error {
  readonly code = "command_environment_quarantined";
  constructor(message: string) { super(message); this.name = "CommandEnvironmentQuarantined"; }
}
