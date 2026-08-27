import { createRequire } from "node:module";

import type { ProviderName } from "../core/types.js";

export type ApiKeyConfigKey = `${ProviderName}.api-key`;

export interface ApiKeyCredentialStore {
  get(provider: ProviderName): Promise<string | undefined>;
  set(provider: ProviderName, value: string): Promise<void>;
  delete(provider: ProviderName): Promise<boolean>;
}

export class EasyCodeCredentialError extends Error {
  constructor(operation: "read" | "write" | "delete") {
    super(
      `Unable to ${operation} the EASY CODE API key in the operating system credential store. ` +
        "Unlock or enable the system keyring, or use the provider API-key environment variable.",
    );
    this.name = "EasyCodeCredentialError";
  }
}

type KeyringModule = typeof import("@napi-rs/keyring");
type KeyringModuleLoader = () => KeyringModule;

const require = createRequire(import.meta.url);
let cachedKeyring: KeyringModule | undefined;

function loadKeyring(): KeyringModule {
  cachedKeyring ??= require("@napi-rs/keyring") as KeyringModule;
  return cachedKeyring;
}

export const EASY_CODE_KEYRING_SERVICE = "easy-code-agent";

export class SystemKeyringCredentialStore implements ApiKeyCredentialStore {
  constructor(
    private readonly service = EASY_CODE_KEYRING_SERVICE,
    private readonly moduleLoader: KeyringModuleLoader = loadKeyring,
  ) {}

  async get(provider: ProviderName): Promise<string | undefined> {
    try {
      const value = await this.entry(provider).getPassword();
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      throw new EasyCodeCredentialError("read");
    }
  }

  async set(provider: ProviderName, value: string): Promise<void> {
    try {
      await this.entry(provider).setPassword(value);
    } catch {
      throw new EasyCodeCredentialError("write");
    }
  }

  async delete(provider: ProviderName): Promise<boolean> {
    try {
      return await this.entry(provider).deleteCredential();
    } catch {
      throw new EasyCodeCredentialError("delete");
    }
  }

  private entry(provider: ProviderName): InstanceType<KeyringModule["AsyncEntry"]> {
    const { AsyncEntry } = this.moduleLoader();
    return new AsyncEntry(this.service, apiKeyConfigKey(provider));
  }
}

export function apiKeyConfigKey(provider: ProviderName): ApiKeyConfigKey {
  return `${provider}.api-key`;
}

export function parseApiKeyConfigKey(value: string): {
  key: ApiKeyConfigKey;
  provider: ProviderName;
} {
  const match = /^(qwen|deepseek)\.api-key$/u.exec(value.trim());
  if (!match) {
    throw new Error(
      "Unsupported configuration key. Valid keys: qwen.api-key, deepseek.api-key.",
    );
  }
  const provider = match[1] as ProviderName;
  return { key: apiKeyConfigKey(provider), provider };
}

export function validateApiKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("API key must not be empty.");
  if (normalized.length > 16_384 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error("API key contains unsupported characters or is too long.");
  }
  return normalized;
}

/** Store one API key and require an exact read-back before reporting success. */
export async function storeVerifiedApiKey(
  credentialStore: ApiKeyCredentialStore,
  provider: ProviderName,
  value: string,
): Promise<string> {
  const normalized = validateApiKey(value);
  await credentialStore.set(provider, normalized);
  let verified: string | undefined;
  try {
    verified = await credentialStore.get(provider);
  } catch {
    // Return one generic verification failure without exposing native keyring
    // errors that could include credential metadata.
  }
  if (verified !== normalized) {
    throw new Error(
      `The operating system credential store did not verify the ${apiKeyConfigKey(provider)} write. ` +
        "Use the provider API-key environment variable or retry after unlocking the keyring.",
    );
  }
  return normalized;
}
