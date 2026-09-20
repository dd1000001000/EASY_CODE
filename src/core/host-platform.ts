export type HostPlatform = "win32" | "darwin" | "linux";

/** Resolve the host once when constructing a platform-dependent service. */
export function hostPlatform(value: NodeJS.Platform = process.platform): HostPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value;
  throw new Error(`Unsupported host platform: ${value}`);
}
