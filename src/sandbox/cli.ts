import type { Command } from "commander";

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function linuxInstallHint(): string {
  return "Install bubblewrap, socat, and ripgrep with your system package manager, then rerun easy-code sandbox doctor.";
}

export function registerSandboxCommands(program: Command): Command {
  const sandbox = program
    .command("sandbox")
    .description("set up or diagnose the Anthropic OS sandbox");

  sandbox
    .command("doctor")
    .description("check whether the OS sandbox can enforce command boundaries")
    .action(async () => {
      const srt = await import("@anthropic-ai/sandbox-runtime");
      if (!srt.SandboxManager.isSupportedPlatform()) {
        writeLine(`Sandbox backend: unsupported (${process.platform})`);
        process.exitCode = 2;
        return;
      }
      if (process.platform === "win32") {
        const resolved = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
        const status = await srt.checkWindowsSandboxStatusAsync({ srtWin: resolved });
        const userReady = status.user.provisioned &&
          status.user.credPresent &&
          status.user.groupExists &&
          status.user.inSandboxGroup;
        let networkReady = false;
        if (userReady) {
          try {
            await srt.verifyWindowsWfpEgress({ srtWin: resolved });
            networkReady = true;
          } catch {
            networkReady = false;
          }
        }
        writeLine("Sandbox backend: Anthropic SRT for Windows (alpha)");
        writeLine(`Filesystem identity: ${userReady ? "ready" : "not initialized"}`);
        writeLine(`Network fence: ${networkReady ? "ready" : status.wfp.state}`);
        if (!userReady || !networkReady) {
          writeLine("Fix: run easy-code sandbox setup and approve the one-time UAC prompt.");
          process.exitCode = 2;
        }
        return;
      }

      const dependencies = await srt.SandboxManager.checkDependenciesAsync();
      writeLine(
        `Sandbox backend: Anthropic SRT for ${process.platform === "darwin" ? "macOS" : "Linux"}`,
      );
      for (const warning of dependencies.warnings) writeLine(`Warning: ${warning}`);
      for (const error of dependencies.errors) writeLine(`Missing: ${error}`);
      if (dependencies.errors.length) {
        if (process.platform === "linux") writeLine(linuxInstallHint());
        else writeLine("Install ripgrep, then rerun easy-code sandbox doctor.");
        process.exitCode = 2;
      } else {
        writeLine("Filesystem and network sandbox dependencies are ready.");
      }
    });

  sandbox
    .command("setup")
    .description("perform required one-time sandbox setup")
    .action(async () => {
      const srt = await import("@anthropic-ai/sandbox-runtime");
      if (process.platform !== "win32") {
        const dependencies = await srt.SandboxManager.checkDependenciesAsync();
        if (dependencies.errors.length) {
          for (const error of dependencies.errors) writeLine(`Missing: ${error}`);
          writeLine(
            process.platform === "linux"
              ? linuxInstallHint()
              : "Install ripgrep with Homebrew, then rerun easy-code sandbox doctor.",
          );
          process.exitCode = 2;
        } else {
          writeLine("No privileged sandbox setup is required on this platform.");
        }
        return;
      }

      writeLine("Windows will request administrator approval once to create the isolated account and WFP rules.");
      const resolved = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
      const result = await srt.installWindowsSandboxAsync({ srtWin: resolved });
      if (result.cancelled) {
        writeLine("Sandbox setup was canceled. EASY CODE will keep command execution fail-closed.");
        process.exitCode = 2;
        return;
      }
      writeLine("Windows sandbox setup completed. Run easy-code sandbox doctor to verify it.");
    });

  sandbox.action(() => sandbox.outputHelp());
  return sandbox;
}
