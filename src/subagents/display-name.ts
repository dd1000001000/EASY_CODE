/**
 * User-facing child-agent names. The name is display-only: models, journals and
 * every lifecycle operation keep addressing children by their Runtime agent ID.
 * This module stays dependency-free so the Web client can share the label rule.
 */

export const MAX_SUBAGENT_DISPLAY_NAME_CHARS = 32;

/** Case-insensitive identity used to keep names unique within one parent Thread. */
export function subagentDisplayNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase();
}

/** The parent-chosen name, or a short ID-derived label for children recorded before names existed. */
export function subagentDisplayLabel(agent: { readonly id: string; readonly displayName?: string }): string {
  if (agent.displayName) return agent.displayName;
  const suffix = agent.id.replace(/^subagent[_-]?/iu, "");
  return suffix ? `agent-${suffix.slice(0, 8)}` : "agent";
}
