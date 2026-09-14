/** Built-in profiles are resolved by the installed native runtime, so EASY CODE
 * does not duplicate platform ACL, Seatbelt, bubblewrap, seccomp, or protected
 * path rules. They are connection-scoped command parameters, not user config. */
export function nativePermissionProfile(readOnly = false): { permissionProfile: ":read-only" | ":workspace" } {
  return { permissionProfile: readOnly ? ":read-only" : ":workspace" };
}
