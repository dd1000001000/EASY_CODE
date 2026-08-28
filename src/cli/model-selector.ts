import type { ProviderName, ThinkingEffort } from "../core/types.js";
import type { VisionSupport } from "../models/catalog.js";
import {
  renderMenu,
  selectMenuIndex,
  type MenuSelectorInput,
  type MenuSelectorOptions,
  type MenuSelectorOutput,
} from "./menu-selector.js";

export interface ProviderSelectorChoice {
  readonly provider: ProviderName;
  readonly label: string;
  readonly apiKeyConfigured: boolean;
}

export interface ModelSelectorChoice {
  readonly id: string;
  readonly label: string;
  readonly vision?: VisionSupport;
}

export interface ThinkingEffortSelectorChoice {
  readonly id: ThinkingEffort;
  readonly label: string;
  readonly applied: boolean;
}

export type ModelSelectorInput = MenuSelectorInput;
export type ModelSelectorOutput = MenuSelectorOutput;

interface SelectorOptions extends MenuSelectorOptions {}

export interface ProviderSelectorOptions extends SelectorOptions {
  readonly initialProvider: ProviderName;
}

export interface ModelChoiceSelectorOptions extends SelectorOptions {
  readonly initialModel?: string;
}

export interface ThinkingEffortSelectorOptions extends SelectorOptions {
  readonly initialEffort: ThinkingEffort;
}

export function renderProviderSelector(
  choices: readonly ProviderSelectorChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    "Select a provider for EASY CODE",
    choices.map((choice) => {
      const status = choice.apiKeyConfigured ? "API key configured" : "API key required";
      return `${choice.label}  [${status}]`;
    }),
    selectedIndex,
    color,
  );
}

export function renderModelSelector(
  providerName: string,
  choices: readonly ModelSelectorChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    `Select a model from ${providerName}`,
    choices.map((choice) => {
      const name = choice.label === choice.id
        ? choice.label
        : `${choice.label}  [${choice.id}]`;
      if (choice.vision === "supported") return `${name}  [vision]`;
      if (choice.vision === "unknown") return `${name}  [vision unverified]`;
      return name;
    }),
    selectedIndex,
    color,
  );
}

export function renderThinkingEffortSelector(
  providerName: string,
  model: string,
  choices: readonly ThinkingEffortSelectorChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    `Select thinking effort for ${providerName} / ${model}`,
    choices.map((choice) =>
      choice.applied
        ? choice.label
        : `${choice.label}  [saved but not applied]`),
    selectedIndex,
    color,
  );
}

export function selectProvider(
  choices: readonly ProviderSelectorChoice[],
  options: ProviderSelectorOptions,
): Promise<ProviderName | undefined> {
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.provider === options.initialProvider),
  );
  return selectMenuIndex(
    choices.length,
    initialIndex,
    (selectedIndex) =>
      renderProviderSelector(choices, selectedIndex, options.color ?? true),
    options,
    "No providers are available.",
  ).then((index) => (index === undefined ? undefined : choices[index]?.provider));
}

export function selectModel(
  providerName: string,
  choices: readonly ModelSelectorChoice[],
  options: ModelChoiceSelectorOptions,
): Promise<string | undefined> {
  const normalizedInitial = options.initialModel?.toLowerCase();
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id.toLowerCase() === normalizedInitial),
  );
  return selectMenuIndex(
    choices.length,
    initialIndex,
    (selectedIndex) =>
      renderModelSelector(providerName, choices, selectedIndex, options.color ?? true),
    options,
    `No models are available for ${providerName}.`,
  ).then((index) => (index === undefined ? undefined : choices[index]?.id));
}

export function selectThinkingEffort(
  providerName: string,
  model: string,
  choices: readonly ThinkingEffortSelectorChoice[],
  options: ThinkingEffortSelectorOptions,
): Promise<ThinkingEffort | undefined> {
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id === options.initialEffort),
  );
  return selectMenuIndex(
    choices.length,
    initialIndex,
    (selectedIndex) =>
      renderThinkingEffortSelector(
        providerName,
        model,
        choices,
        selectedIndex,
        options.color ?? true,
      ),
    options,
    `No thinking efforts are available for ${providerName} / ${model}.`,
  ).then((index) => (index === undefined ? undefined : choices[index]?.id));
}
