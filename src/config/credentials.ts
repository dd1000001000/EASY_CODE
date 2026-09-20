import { createRequire } from "node:module";
import { recordOwnedResource } from "../install/ownership.js";

import type { ProviderName } from "../core/types.js";
import {
  PROVIDER_CATALOG,
  providerCatalogEntry,
  providerCredentialConfigKey,
} from "../models/catalog.js";

export type ApiKeyConfigKey = `${ProviderName}.api-key`;

export interface ApiKeyCredentialStore {
  get(provider: ProviderName, endpoint?: string): Promise<string | undefined>;
  set(provider: ProviderName, value: string, endpoint?: string): Promise<void>;
  delete(provider: ProviderName): Promise<boolean>;
}

export class EasyCodeCredentialError extends Error {
  constructor(operation: "read" | "write" | "delete") {
    super(
      `Unable to ${operation} the EASY CODE API key in the operating system credential store. ` +
        "Unlock or enable the system credential store and retry.",
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
export const EASY_CODE_BENCHMARK_KEYRING_SERVICE = "easy-code-agent-benchmark";

function canonicalEndpoint(provider: ProviderName, endpoint?: string): string {
  const url = new URL(endpoint ?? providerCatalogEntry(provider).defaultBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Provider ${provider} must use an HTTPS endpoint without embedded credentials.`);
  }
  return url.href.replace(/\/+$/u, "");
}

interface StoredApiKey {
  version: 1;
  endpoint: string;
  apiKey: string;
}

function parseStoredApiKey(value: string): StoredApiKey {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credential format");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.endpoint !== "string" ||
      typeof record.apiKey !== "string" || !record.apiKey ||
      Object.keys(record).some(key => !["version", "endpoint", "apiKey"].includes(key))) {
    throw new Error("Invalid credential format");
  }
  return record as unknown as StoredApiKey;
}

export class SystemKeyringCredentialStore implements ApiKeyCredentialStore {
  constructor(
    private readonly service = EASY_CODE_KEYRING_SERVICE,
    private readonly moduleLoader: KeyringModuleLoader = loadKeyring,
  ) {}

  async get(provider: ProviderName, endpoint?: string): Promise<string | undefined> {
    try {
      const value = await this.entry(provider).getPassword();
      if (!value) return undefined;
      const stored = parseStoredApiKey(value);
      return stored.endpoint === canonicalEndpoint(provider, endpoint) ? stored.apiKey : undefined;
    } catch {
      throw new EasyCodeCredentialError("read");
    }
  }

  async set(provider: ProviderName, value: string, endpoint?: string): Promise<void> {
    const payload = JSON.stringify({
      version: 1, endpoint: canonicalEndpoint(provider, endpoint), apiKey: value,
    } satisfies StoredApiKey);
    // Windows Credential Manager limits the UTF-16 credential blob to 2560 bytes.
    // Use the portable limit on every platform so a key can move between hosts.
    if (Buffer.byteLength(payload, "utf16le") > 2560) {
      throw new Error("API key and endpoint exceed the system credential store's portable 2560-byte limit.");
    }
    try {
      if (this.moduleLoader === loadKeyring)
        recordOwnedResource({ kind: "credential", name: apiKeyConfigKey(provider), connection: this.service });
      await this.entry(provider).setPassword(payload);
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
    return new AsyncEntry(
      this.service, apiKeyConfigKey(provider),
      { linux: { store: "secret-service" } },
    );
  }
}

export function apiKeyConfigKey(provider: ProviderName): ApiKeyConfigKey {
  return providerCredentialConfigKey(provider);
}

export function parseApiKeyConfigKey(value: string): {
  key: ApiKeyConfigKey;
  provider: ProviderName;
} {
  const normalized = value.trim();
  const entry = PROVIDER_CATALOG.find(
    (candidate) => candidate.configKey === normalized,
  );
  if (!entry) {
    throw new Error(
      `Unsupported configuration key. Valid keys: ${PROVIDER_CATALOG.map(
        ({ configKey }) => configKey,
      ).join(", ")}.`,
    );
  }
  return { key: entry.configKey, provider: entry.provider };
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
  endpoint?: string,
): Promise<string> {
  const normalized = validateApiKey(value);
  await credentialStore.set(provider, normalized, endpoint);
  let verified: string | undefined;
  try {
    verified = await credentialStore.get(provider, endpoint);
  } catch {
    // Return one generic verification failure without exposing native keyring
    // errors that could include credential metadata.
  }
  if (verified !== normalized) {
    throw new Error(
      `The operating system credential store did not verify the ${apiKeyConfigKey(provider)} write. ` +
        "Retry after unlocking the system credential store.",
    );
  }
  return normalized;
}
