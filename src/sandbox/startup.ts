import { executionCapabilities } from "./capabilities.js";

export type SandboxReadinessStatus =
  | "ready"
  | "setup_required"
  | "dependencies_missing"
  | "unsupported"
  | "probe_failed";

export interface SandboxReadiness {
  readonly status: SandboxReadinessStatus;
  readonly platform: NodeJS.Platform;
  readonly backend: string;
  readonly details: readonly string[];
  readonly warnings: readonly string[];
  readonly canSetup: boolean;
}

export type SandboxSetupStatus =
  | "completed"
  | "already_ready"
  | "cancelled"
  | "unavailable"
  | "failed";

export interface SandboxSetupResult {
  readonly status: SandboxSetupStatus;
  readonly message: string;
  readonly readiness: SandboxReadiness;
}

export interface SandboxStartupService {
  inspect(): Promise<SandboxReadiness>;
  setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDetail(value: string, maximum = 2_000): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

export function sandboxIsReady(readiness: SandboxReadiness): boolean {
  return readiness.status === "ready";
}

export function formatSandboxReadiness(readiness: SandboxReadiness): string[] {
  const lines = [`Sandbox backend: ${readiness.backend}`];
  if (readiness.status === "ready") {
    lines.push("Filesystem and network sandbox checks passed.");
  } else if (readiness.status === "setup_required") {
    lines.push("One-time operating-system sandbox setup is required.");
  } else if (readiness.status === "dependencies_missing") {
    lines.push("Required operating-system sandbox dependencies are missing.");
  } else if (readiness.status === "unsupported") {
    lines.push("The configured backend cannot provide the required command sandbox.");
  } else {
    lines.push("The sandbox enforcement probe did not pass.");
  }
  for (const detail of readiness.details) lines.push(`Detail: ${safeDetail(detail)}`);
  for (const warning of readiness.warnings) lines.push(`Warning: ${safeDetail(warning)}`);
  const capabilities = executionCapabilities("native");
  lines.push(`Compatibility policy (not a language test): ${JSON.stringify(capabilities.features)}`);
  for (const note of capabilities.notes) lines.push(`Compatibility: ${note}`);
  return lines;
}

export interface SandboxStartupTerminal {
  selectChoice(
    title: string,
    choices: readonly { id: string; label: string; detail?: string }[],
    initialId?: string,
  ): Promise<string | undefined>;
  info(text: string): void;
  success(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  startActivity(text: string): void;
  stopActivity(): void;
}

/** Prepare missing prerequisites once, then offer recovery in the retained terminal. */
export async function runSandboxStartupGuide(
  service: SandboxStartupService,
  terminal: SandboxStartupTerminal,
): Promise<boolean> {
  terminal.startActivity("Checking the command sandbox");
  let readiness: SandboxReadiness;
  try {
    readiness = await service.inspect();
  } finally {
    terminal.stopActivity();
  }
  if (sandboxIsReady(readiness)) {
    return true;
  }

  const setup = async (): Promise<boolean> => {
    const result = await service.setup(readiness);
    readiness = result.readiness;
    if ((result.status === "completed" || result.status === "already_ready") && sandboxIsReady(readiness)) {
      terminal.success(safeDetail(result.message));
      return true;
    }
    if (result.status === "cancelled" || result.status === "unavailable") terminal.warning(safeDetail(result.message));
    else terminal.error(safeDetail(result.message));
    return false;
  };

  // One automatic attempt per startup. A probe/cleanup failure is not a missing
  // installation; never rebuild it blindly or loop after denied OS approval.
  if (readiness.canSetup && ["dependencies_missing", "setup_required"].includes(readiness.status)) {
    terminal.info("Preparing the native command sandbox. Windows may request one administrator-approved setup; macOS and Linux use the packaged native runtime without a virtual machine.");
    terminal.startActivity("Setting up the command sandbox");
    try {
      if (await setup()) return true;
    } catch (error) {
      terminal.error(`Sandbox startup operation failed: ${safeDetail(errorMessage(error))}`);
    } finally {
      terminal.stopActivity();
    }
  }

  while (true) {
    for (const line of formatSandboxReadiness(readiness)) terminal.warning(line);
    const choices = [
      ...(readiness.canSetup
        ? [{
            id: "setup",
            label: "Set up sandbox now (Recommended)",
            detail: "Prepare the operating-system sandbox; Windows may request administrator approval",
          }]
        : []),
      { id: "recheck", label: "Recheck sandbox", detail: "Run the readiness probe again" },
      {
        id: "continue",
        label: "Continue with sandboxed commands blocked",
        detail: "Chat and workspace file tools remain available; dangerous full access requires a separate confirmation",
      },
      { id: "exit", label: "Exit EASY CODE", detail: "Make no further system changes" },
    ];
    const selected = await terminal.selectChoice(
      "Command sandbox is not ready",
      choices,
      readiness.canSetup ? "setup" : "recheck",
    );
    if (!selected || selected === "exit") return false;
    if (selected === "continue") {
      terminal.warning(
        "Continuing without a ready OS sandbox. Workspace-sandbox commands remain fail-closed. " +
          "Host execution requires an explicit host-scoped approval or confirmation through /approval > Full access; it is never an automatic fallback.",
      );
      return true;
    }

    terminal.startActivity(
      selected === "setup" ? "Setting up the command sandbox" : "Checking the command sandbox",
    );
    try {
      if (selected === "setup") {
        if (await setup()) return true;
      } else {
        readiness = await service.inspect();
        if (sandboxIsReady(readiness)) {
          terminal.success("Command sandbox verification passed.");
          return true;
        }
      }
    } catch (error) {
      terminal.error(`Sandbox startup operation failed: ${safeDetail(errorMessage(error))}`);
      readiness = await service.inspect();
    } finally {
      terminal.stopActivity();
    }
  }
}
