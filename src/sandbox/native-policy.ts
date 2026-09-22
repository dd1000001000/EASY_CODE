/** Built-in profiles are resolved by the installed native runtime, so EASY CODE
 * does not duplicate platform ACL, Seatbelt, bubblewrap, seccomp, or protected
 * path rules. They are connection-scoped command parameters, not user config. */
export function nativePermissionProfile(readOnly = false): { permissionProfile: ":read-only" | ":workspace" } {
  return { permissionProfile: readOnly ? ":read-only" : ":workspace" };
}

export const NATIVE_PROJECT_PERMISSION_PROFILE = "easy-code-project";
export const NATIVE_PROJECT_READ_ONLY_PROFILE = "easy-code-project-read-only";
export const NATIVE_SERVICE_PERMISSION_PROFILE = "easy-code-local-service";

function tableEntries(writableRoots: readonly string[]): string {
  return [...new Set(writableRoots)].map(root => `${JSON.stringify(root)} = true`).join("\n");
}

function filesystemRule(access: "read" | "write"): string {
  // Inline form is accepted consistently by the pinned Codex runtime; some
  // versions reject an equivalent nested :workspace_roots TOML table.
  return `\":workspace_roots\" = { \".\" = \"${access}\" }`;
}

/** Isolated Codex permission profiles for every folder in a logical project. */
export function nativeProjectPermissionConfig(writableRoots: readonly string[]): string {
  if (!writableRoots.length) throw new Error("Native project permissions require at least one workspace root");
  const roots = tableEntries(writableRoots);
  return `default_permissions = "${NATIVE_PROJECT_PERMISSION_PROFILE}"
[windows]
sandbox = "elevated"

[features]
network_proxy = true

[permissions.${NATIVE_PROJECT_PERMISSION_PROFILE}]
extends = ":workspace"
[permissions.${NATIVE_PROJECT_PERMISSION_PROFILE}.workspace_roots]
${roots}
[permissions.${NATIVE_PROJECT_PERMISSION_PROFILE}.filesystem]
${filesystemRule("write")}

[permissions.${NATIVE_PROJECT_READ_ONLY_PROFILE}]
extends = ":read-only"
[permissions.${NATIVE_PROJECT_READ_ONLY_PROFILE}.workspace_roots]
${roots}
[permissions.${NATIVE_PROJECT_READ_ONLY_PROFILE}.filesystem]
${filesystemRule("read")}

[permissions.${NATIVE_SERVICE_PERMISSION_PROFILE}]
extends = ":workspace"
[permissions.${NATIVE_SERVICE_PERMISSION_PROFILE}.workspace_roots]
${roots}
[permissions.${NATIVE_SERVICE_PERMISSION_PROFILE}.filesystem]
${filesystemRule("write")}
[permissions.${NATIVE_SERVICE_PERMISSION_PROFILE}.network]
enabled = true
allow_local_binding = true
[permissions.${NATIVE_SERVICE_PERMISSION_PROFILE}.network.domains]
"127.0.0.1" = "allow"
"localhost" = "allow"
`;
}

export function nativeProjectPermissionProfile(readOnly = false): { permissionProfile: string } {
  return { permissionProfile: readOnly ? NATIVE_PROJECT_READ_ONLY_PROFILE : NATIVE_PROJECT_PERMISSION_PROFILE };
}
