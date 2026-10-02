import { ref, watch } from "vue";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "easy-code-theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

const systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

/** The user's choice; "system" follows the operating system's light/dark setting. */
export const themePreference = ref<ThemePreference>(stored());

function apply(): void {
  const dark = themePreference.value === "dark" || (themePreference.value === "system" && Boolean(systemDark?.matches));
  // Element Plus and the Shiki code colours switch on the same class.
  document.documentElement.classList.toggle("dark", dark);
}

/** Apply the saved theme before the first paint, and keep following the system while it is chosen. */
export function initTheme(): void {
  apply();
  systemDark?.addEventListener("change", apply);
  watch(themePreference, (value) => {
    try {
      if (value === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Private browsing may refuse storage; the choice still applies to this page.
    }
    apply();
  });
}

export function nextTheme(): void {
  themePreference.value = ORDER[(ORDER.indexOf(themePreference.value) + 1) % ORDER.length]!;
}
