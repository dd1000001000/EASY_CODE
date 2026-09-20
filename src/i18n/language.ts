import type { EasyCodeStorage } from "../storage/database.js";
import { translate } from "./catalog.js";

export const LANGUAGES = ["en_us", "zh_cn"] as const;
export type Language = typeof LANGUAGES[number];
export const DEFAULT_LANGUAGE: Language = "en_us";

const LANGUAGE_KEY = "language";

export function parseLanguage(value: string, current: Language = DEFAULT_LANGUAGE): Language {
  if ((LANGUAGES as readonly string[]).includes(value)) return value as Language;
  throw new Error(translate(current, "language.usage"));
}

export function readLanguage(storage: EasyCodeStorage): Language {
  const row = storage.db.prepare<[string], { value_json: string }>(
    "SELECT value_json FROM preferences WHERE key = ?",
  ).get(LANGUAGE_KEY);
  if (!row) return DEFAULT_LANGUAGE;
  try {
    const value: unknown = JSON.parse(row.value_json);
    return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value)
      ? value as Language : DEFAULT_LANGUAGE;
  } catch { return DEFAULT_LANGUAGE; }
}

export function writeLanguage(storage: EasyCodeStorage, language: Language): void {
  storage.db.prepare<[string, string]>(
    "INSERT INTO preferences(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(LANGUAGE_KEY, JSON.stringify(language));
}

export function executeLanguageCommand(storage: EasyCodeStorage, args: readonly string[]): {
  language: Language; changed: boolean;
} {
  const current = readLanguage(storage);
  if (args.length > 1) throw new Error(translate(current, "language.usage"));
  if (!args.length) return { language: current, changed: false };
  const language = parseLanguage(args[0]!, current);
  writeLanguage(storage, language);
  return { language, changed: language !== current };
}
