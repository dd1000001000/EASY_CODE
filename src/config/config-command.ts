import path from "node:path";
import { defaultRuntimeLimits } from "./runtime-limits.js";

import type { Command } from "commander";

import type { ProviderName } from "../core/types.js";
import {
  PROVIDER_CATALOG,
  providerApiKeyEnvironmentVariables,
  providerCredentialConfigKey,
} from "../models/catalog.js";
import {
  SystemKeyringCredentialStore,
  apiKeyConfigKey,
  parseApiKeyConfigKey,
  storeVerifiedApiKey,
  type ApiKeyConfigKey,
  type ApiKeyCredentialStore,
} from "./credentials.js";
import { resolveEasyCodePaths } from "./defaults.js";
import { hasLegacyUserApiKey } from "./loader.js";
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
  | { state: "configured"; source: string }
  | { state: "unavailable-or-not-configured" };

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
      const { steps, providerTimeoutMs, ...limits } = defaultRuntimeLimits();
      const table = (name: string, values: Record<string, unknown>) =>
        `[${name}]\n` + Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n");
      writeLine(resolveRuntime(runtime).output,
        "orchestrationEnabled = false\n\n" + table("limits", limits) + "\n\n" +
        table("limits.steps", steps) + "\n\n" + table("limits.providerTimeoutMs", providerTimeoutMs));
    });

  config
    .command("set")
    .description("store a provider API key in the operating system credential store")
    .argument("<key>", "provider API-key name")
    .allowExcessArguments(false)
    .addHelpText(
      "after",
      "\nThe API key is read through hidden terminal input, or from standard input when piped. " +
        "It cannot be passed as a command argument.\n",
    )
    .action(async (rawKey: string) => {
      const { key, provider } = parseApiKeyConfigKey(rawKey);
      const resources = resolveRuntime(runtime);
      const value = await readSecretInput(
        resources.input,
        resources.errorOutput,
        `API key for ${provider}: `,
      );
      await storeVerifiedApiKey(resources.credentialStore, provider, value);
      writeLine(
        resources.output,
        `Stored ${key} in the operating system credential store.`,
      );
      const overridingEnvironment = environmentApiKeySource(provider, resources.env);
      if (overridingEnvironment) {
        writeLine(
          resources.errorOutput,
          `Note: ${key} remains overridden by environment variable ${overridingEnvironment}.`,
        );
      }
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

      const remaining = await remainingExternalSource(provider, resources);
      if (remaining) {
        writeLine(
          resources.errorOutput,
          `Note: ${key} remains configured through ${remaining}; unset does not modify that source.`,
        );
      }
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
  const environment = environmentApiKeySource(provider, runtime.env);
  if (environment) {
    return { state: "configured", source: `environment variable ${environment}` };
  }

  try {
    if (await runtime.credentialStore.get(provider)) {
      return {
        state: "configured",
        source: "operating system credential store",
      };
    }
  } catch {
    // A read error and an absent entry cannot be distinguished reliably by all
    // supported native backends. Keep the public status deliberately ambiguous.
  }

  if (await hasLegacyUserApiKey(runtime.userConfigPath, provider)) {
    return { state: "configured", source: "legacy user config" };
  }
  return { state: "unavailable-or-not-configured" };
}

async function remainingExternalSource(
  provider: ProviderName,
  runtime: ResolvedRuntime,
): Promise<string | undefined> {
  const environment = environmentApiKeySource(provider, runtime.env);
  if (environment) return `environment variable ${environment}`;
  return (await hasLegacyUserApiKey(runtime.userConfigPath, provider))
    ? "legacy user config"
    : undefined;
}

function environmentApiKeySource(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const names = providerApiKeyEnvironmentVariables(provider);
  return names.find((name) => Boolean(env[name]?.trim()));
}

function formatStatus(key: ApiKeyConfigKey, status: ApiKeyStatus): string {
  if (status.state === "configured") {
    return `${key}=[configured] (${status.source})`;
  }
  return `${key}=[unavailable or not configured]`;
}

function writeLine(output: SecretOutputStream, value: string): void {
  output.write(`${value}\n`);
}
