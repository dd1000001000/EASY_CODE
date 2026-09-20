import { THINKING_EFFORTS, type ProviderName, type ThinkingEffort } from "../core/types.js";
import { requireCatalogModel } from "../models/catalog.js";
import type { EasyCodeStorage } from "../storage/database.js";

export interface LastModelSelection {
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
}

const KEY = "last_model";

export function readLastModel(storage: EasyCodeStorage): LastModelSelection | undefined {
  const row = storage.db.prepare<[string], { value_json: string }>(
    "SELECT value_json FROM preferences WHERE key = ?",
  ).get(KEY);
  if (!row) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value_json); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.provider !== "string" || typeof value.model !== "string" ||
      !THINKING_EFFORTS.includes(value.thinkingEffort as ThinkingEffort)) return undefined;
  try {
    const model = requireCatalogModel(value.provider as ProviderName, value.model);
    return { provider: value.provider, model: model.id, thinkingEffort: value.thinkingEffort as ThinkingEffort };
  } catch { return undefined; }
}

export function writeLastModel(storage: EasyCodeStorage, selection: Readonly<LastModelSelection>): void {
  const model = requireCatalogModel(selection.provider, selection.model);
  if (!THINKING_EFFORTS.includes(selection.thinkingEffort)) throw new Error("Invalid thinking effort");
  storage.db.prepare<[string, string]>(
    "INSERT INTO preferences(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(KEY, JSON.stringify({ provider: selection.provider, model: model.id, thinkingEffort: selection.thinkingEffort }));
}
