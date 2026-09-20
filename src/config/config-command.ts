import path from "node:path";
import { defaultRuntimeLimits } from "./runtime-limits.js";

import type { Command } from "commander";

import type { ProviderName } from "../core/types.js";
import {
  PROVIDER_CATALOG,
  providerCredentialConfigKey,
} from "../models/catalog.js";
import { loadEasyCodeConfig } from "./loader.js";
import {
  SystemKeyringCredentialStore,
  apiKeyConfigKey,
  parseApiKeyConfigKey,
  storeVerifiedApiKey,
  type ApiKeyConfigKey,
  type ApiKeyCredentialStore,
} from "./credentials.js";
import { resolveEasyCodePaths } from "./defaults.js";
import {
  readSecretInput,
  type SecretInputStream,
  type SecretOutputStream,
} from "./secret-input.js";

export interface ConfigCommandRuntime {
  credentialStore?: ApiKeyCredentialStore;
  env?: NodeJS.ProcessEnv;
  input?: SecretInputStream;
  output?: SecretOutputStream;
  errorOutput?: SecretOutputStream;
  appName?: string;
  configDir?: string;
  userConfigPath?: string;
}

type ApiKeyStatus =
  | { state: "configured" }
  | { state: "not-configured" }
  | { state: "unavailable" };

export function registerConfigCommands(
  program: Command,
  runtime: ConfigCommandRuntime = {},
): Command {
  const config = program
    .command("config")
    .description("inspect or update user API-key configuration")
    .addHelpText(
      "after",
      `\nSupported keys: ${PROVIDER_CATALOG.map(({ provider }) =>
        providerCredentialConfigKey(provider)).join(", ")}. ` +
        "Keys are stored in the operating system credential store, never in workspace configuration.\n",
    );

  config
    .command("defaults")
    .description("print the complete operational limits as TOML (no credentials)")
    .allowExcessArguments(false)
    .action(() => {
      const { steps, maxResponseTokens, maxConcurrentSubagents, providerStreamIdleTimeoutMs,
        providerBufferedTimeoutMs, ...limits } = defaultRuntimeLimits();
      const snakeCase = (value: string) => value.replace(/[A-Z]/gu, character => `_${character.toLowerCase()}`);
      const table = (name: string, values: Record<string, unknown>) =>
        `[${name}]\n` + Object.entries(values).map(([key, value]) => `${snakeCase(key)} = ${JSON.stringify(value)}`).join("\n");
      writeLine(resolveRuntime(runtime).output,
        "orchestration_enabled = false\n\n" + table("limits", limits) + "\n\n" +
        table("limits.steps", steps) + "\n\n" + table("limits.max_response_tokens", maxResponseTokens) +
        "\n\n" + table("limits.max_concurrent_subagents", maxConcurrentSubagents) +
        "\n\n" + table("limits.provider_stream_idle_timeout_ms", providerStreamIdleTimeoutMs) +
        "\n\n" + table("limits.provider_buffered_timeout_ms", providerBufferedTimeoutMs));
    });

  config
    .command("set")
    .description("store a provider API key in the operating system credential store")
    .argument("<key>", "provider API-key name")
    .allowExcessArguments(false)
    .addHelpText(
      "after",
      "\nThe API key is masked with dots in an interactive terminal, or read from standard input when piped. " +
        "It cannot be passed as a command argument.\n",
    )
    .action(async (rawKey: string) => {
      const { key, provider } = parseApiKeyConfigKey(rawKey);
      const resources = resolveRuntime(runtime);
      const endpoint = await endpointFor(provider, resources);
      const value = await readSecretInput(
        resources.input,
        resources.errorOutput,
        `API key for ${provider}: `,
      );
      await storeVerifiedApiKey(resources.credentialStore, provider, value, endpoint);
      writeLine(
        resources.output,
        `Stored ${key} in the operating system credential store.`,
      );
    });

  config
    .command("get")
    .description("show whether one provider API key is configured (never prints the key)")
    .argument("<key>", "provider API-key name")
    .allowExcessArguments(false)
    .action(async (rawKey: string) => {
      const { key, provider } = parseApiKeyConfigKey(rawKey);
      const resources = resolveRuntime(runtime);
      const status = await apiKeyStatus(provider, resources);
      writeLine(resources.output, formatStatus(key, status));
    });

  config
    .command("unset")
    .description("delete a provider API key from the operating system credential store")
    .argument("<key>", "provider API-key name")
    .allowExcessArguments(false)
    .action(async (rawKey: string) => {
      const { key, provider } = parseApiKeyConfigKey(rawKey);
      const resources = resolveRuntime(runtime);
      const deleted = await resources.credentialStore.delete(provider);
      if (!deleted) {
        throw new Error(
          `${key} was not deleted or deletion could not be verified by the operating system credential store.`,
        );
      }
      writeLine(
        resources.output,
        `Deleted ${key} from the operating system credential store.`,
      );
    });

  config
    .command("list")
    .description("show API-key configuration status for every supported provider")
    .allowExcessArguments(false)
    .action(async () => {
      const resources = resolveRuntime(runtime);
      for (const { provider } of PROVIDER_CATALOG) {
        const status = await apiKeyStatus(provider, resources);
        writeLine(
          resources.output,
          formatStatus(apiKeyConfigKey(provider), status),
        );
      }
    });

  config.action(() => config.outputHelp());
  return config;
}

interface ResolvedRuntime {
  credentialStore: ApiKeyCredentialStore;
  env: NodeJS.ProcessEnv;
  configDir: string;
  input: SecretInputStream;
  output: SecretOutputStream;
  errorOutput: SecretOutputStream;
  userConfigPath: string;
}

function resolveRuntime(runtime: ConfigCommandRuntime): ResolvedRuntime {
  const env = runtime.env ?? process.env;
  const generatedConfigDir = resolveEasyCodePaths(runtime.appName ?? "easy-code").configDir;
  const environmentConfigDir = env.EASY_CODE_CONFIG_DIR?.trim();
  const configDir = path.resolve(
    runtime.configDir ?? (environmentConfigDir || generatedConfigDir),
  );
  return {
    credentialStore:
      runtime.credentialStore ?? new SystemKeyringCredentialStore(),
    env,
    configDir,
    input: runtime.input ?? process.stdin,
    output: runtime.output ?? process.stdout,
    errorOutput: runtime.errorOutput ?? process.stderr,
    userConfigPath: path.resolve(
      runtime.userConfigPath ?? path.join(configDir, "config.toml"),
    ),
  };
}

async function apiKeyStatus(
  provider: ProviderName,
  runtime: ResolvedRuntime,
): Promise<ApiKeyStatus> {
  const endpoint = await endpointFor(provider, runtime);
  try {
    return await runtime.credentialStore.get(provider, endpoint)
      ? { state: "configured" } : { state: "not-configured" };
  } catch {
    return { state: "unavailable" };
  }
}

async function endpointFor(
  provider: ProviderName,
  runtime: ResolvedRuntime,
): Promise<string> {
  const config = await loadEasyCodeConfig({
    env: runtime.env, configDir: runtime.configDir,
    userConfigPath: runtime.userConfigPath, credentialStore: false,
  });
  return config.providers[provider]!.baseUrl;
}

function formatStatus(key: ApiKeyConfigKey, status: ApiKeyStatus): string {
  if (status.state === "configured") {
    return `${key}=[configured] (operating system credential store)`;
  }
  return `${key}=[${status.state === "unavailable" ? "credential store unavailable" : "not configured for this endpoint"}]`;
}

function writeLine(output: SecretOutputStream, value: string): void {
  output.write(`${value}\n`);
}
