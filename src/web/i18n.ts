import { ref } from "vue";
import { translate, type MessageKey } from "../i18n/catalog.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/language.js";

export const language = ref<Language>(DEFAULT_LANGUAGE);

export function setLanguage(value: Language): void {
  language.value = value;
  document.documentElement.lang = value === "zh_cn" ? "zh-CN" : "en-US";
}

export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return translate(language.value, key, params);
}
