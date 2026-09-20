import type { HostPlatform } from "../../core/host-platform.js";
import type { CommandWorkerPlatform } from "./worker-types.js";
import { WindowsCommandWorker } from "./windows.js";
import { MacCommandWorker } from "./macos.js";
import { LinuxCommandWorker } from "./linux.js";

export function createCommandWorker(platform: HostPlatform): CommandWorkerPlatform {
  switch (platform) {
    case "win32": return new WindowsCommandWorker();
    case "darwin": return new MacCommandWorker();
    case "linux": return new LinuxCommandWorker();
  }
}
