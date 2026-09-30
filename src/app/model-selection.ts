/** Provider/model selection for the app: picker flow, API-key checks, and committing the choice to the Thread. */

import type { AppInteractionPort } from "../ui/interaction-port.js";
import { apiKeyConfigKey, storeVerifiedApiKey, type ApiKeyCredentialStore } from "../config/credentials.js";
import { writeLastModel } from "../config/last-model.js";
import { readLanguage } from "../i18n/language.js";
import { translate } from "../i18n/catalog.js";
import type { EasyCodeConfig, ImageAttachment, ProviderName, SessionState, ThinkingEffort } from "../core/types.js";
import { THINKING_EFFORTS } from "../core/types.js";
import {
  DEFAULT_MODEL_IDS,
  PROVIDER_CATALOG,
  modelsForProvider,
  providerLabel,
  requireCatalogModel,
  resolveCatalogModel,
  modelSupportsVision,
} from "../models/catalog.js";
import { thinkingEffortIsApplied } from "../models/thinking.js";
import { type EasyCodeStorage } from "../storage/database.js";

/** What ModelSelection needs from its host; live values are forwarded through getters. */
export interface ModelSelectionContext {
  readonly config: EasyCodeConfig;
  readonly credentialStore: ApiKeyCredentialStore | undefined;
  dirty: boolean;
  readonly handleSlashCommand: (input: string) => Promise<boolean>;
  readonly pendingImages: ImageAttachment[];
  readonly save: () => void;
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly syncTerminalView: (announceHeader?: boolean) => void;
  readonly terminal: AppInteractionPort;
}

export class ModelSelection {
  constructor(private readonly ctx: ModelSelectionContext) {}

  async selectModelFromPicker(announceCancellation: boolean): Promise<void> {
    const selection = await this.selectProviderAndModel();
    if (!selection) {
      if (announceCancellation) this.ctx.terminal.info(translate(readLanguage(this.ctx.storage), "cli.modelCanceled"));
      return;
    }
    if (!(await this.ensureProviderApiKey(selection.provider))) return;
    await this.ctx.handleSlashCommand(`/model ${selection.provider} ${selection.model} ${selection.thinkingEffort}`);
  }

  async selectProviderAndModel(): Promise<
    | {
        provider: ProviderName;
        model: string;
        thinkingEffort: ThinkingEffort;
      }
    | undefined
  > {
    const provider = await this.ctx.terminal.selectProvider(
      PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        label: entry.label,
        apiKeyConfigured: Boolean(this.ctx.config.providers[entry.provider]?.apiKey),
      })),
      this.ctx.state.provider,
    );
    if (!provider) return undefined;

    const configuredModel = this.ctx.config.providers[provider]!.model;
    const initialModel = resolveCatalogModel(provider, configuredModel)?.id ?? DEFAULT_MODEL_IDS[provider];
    const model = await this.ctx.terminal.selectModel(
      providerLabel(provider),
      modelsForProvider(provider),
      initialModel,
    );
    if (!model) return undefined;
    const canonicalModel = requireCatalogModel(provider, model).id;
    const language = readLanguage(this.ctx.storage);
    const thinkingEffort = await this.ctx.terminal.selectThinkingEffort(
      providerLabel(provider),
      canonicalModel,
      THINKING_EFFORTS.map((effort) => ({
        id: effort,
        label: translate(
          language,
          effort === "none"
            ? "ui.effortNone"
            : effort === "low"
              ? "ui.effortLow"
              : effort === "medium"
                ? "ui.effortMedium"
                : "ui.effortHigh",
        ),
        applied: thinkingEffortIsApplied(provider, canonicalModel, effort),
      })),
      this.ctx.state.thinkingEffort,
    );
    if (!thinkingEffort) return undefined;
    return { provider, model: canonicalModel, thinkingEffort };
  }

  async ensureProviderApiKey(provider: ProviderName): Promise<boolean> {
    if (this.ctx.config.providers[provider]?.apiKey) return true;
    if (!this.ctx.credentialStore) {
      throw new Error(
        `No ${provider} API key is configured, and the system credential store is unavailable. ` +
          `Run easy-code config set ${apiKeyConfigKey(provider)}.`,
      );
    }
    const language = readLanguage(this.ctx.storage);
    this.ctx.terminal.info(translate(language, "cli.missingApiKey", { provider: providerLabel(provider) }));
    let value: string;
    try {
      value = await this.ctx.terminal.readSecret(
        translate(language, "cli.enterApiKey", { provider: providerLabel(provider) }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "API key input was canceled.") {
        this.ctx.terminal.info(translate(language, "cli.apiKeyCanceled"));
        return false;
      }
      throw error;
    }
    const normalized = await storeVerifiedApiKey(
      this.ctx.credentialStore,
      provider,
      value,
      this.ctx.config.providers[provider]?.baseUrl,
    );
    this.ctx.config.providers[provider]!.apiKey = normalized;
    this.ctx.terminal.success(translate(language, "cli.apiKeySaved", { key: apiKeyConfigKey(provider) }));
    return true;
  }

  commitModelSelection(
    provider: ProviderName,
    model: string,
    verb = "Model switched to",
    thinkingEffort = this.ctx.state.thinkingEffort,
  ): void {
    const canonicalModel = requireCatalogModel(provider, model).id;
    const previous = {
      stateProvider: this.ctx.state.provider,
      stateModel: this.ctx.state.model,
      stateThinkingEffort: this.ctx.state.thinkingEffort,
      configProvider: this.ctx.config.provider,
      configModel: this.ctx.config.providers[provider]!.model,
      configThinkingEffort: this.ctx.config.thinkingEffort,
      dirty: this.ctx.dirty,
    };
    try {
      this.ctx.state.provider = provider;
      this.ctx.state.model = canonicalModel;
      this.ctx.state.thinkingEffort = thinkingEffort;
      this.ctx.config.provider = provider;
      this.ctx.config.providers[provider]!.model = canonicalModel;
      this.ctx.config.thinkingEffort = thinkingEffort;
      this.ctx.dirty = true;
      this.ctx.save();
    } catch (error) {
      this.ctx.state.provider = previous.stateProvider;
      this.ctx.state.model = previous.stateModel;
      this.ctx.state.thinkingEffort = previous.stateThinkingEffort;
      this.ctx.config.provider = previous.configProvider;
      this.ctx.config.providers[provider]!.model = previous.configModel;
      this.ctx.config.thinkingEffort = previous.configThinkingEffort;
      this.ctx.dirty = previous.dirty;
      throw error;
    }
    this.rememberLastModel();
    this.ctx.syncTerminalView();
    const applied = thinkingEffortIsApplied(provider, canonicalModel, thinkingEffort);
    const language = readLanguage(this.ctx.storage);
    const verbKey =
      verb === "Selected"
        ? "cli.selectedModel"
        : verb === "Provider switched to"
          ? "cli.providerSwitched"
          : "cli.modelSwitched";
    this.ctx.terminal.success(
      translate(language, verbKey, {
        provider: providerLabel(provider),
        model: canonicalModel,
        effort: thinkingEffort,
        suffix: applied ? "" : translate(language, "cli.notAppliedSuffix"),
      }),
    );
    if (this.ctx.pendingImages.length && !modelSupportsVision(provider, canonicalModel)) {
      this.ctx.terminal.info(translate(language, "cli.imagesUnsupported", { count: this.ctx.pendingImages.length }));
    }
  }

  rememberLastModel(): void {
    try {
      writeLastModel(this.ctx.storage, {
        provider: this.ctx.state.provider,
        model: this.ctx.state.model,
        thinkingEffort: this.ctx.state.thinkingEffort,
      });
    } catch (error) {
      this.ctx.terminal.warning(
        `Could not save the last-used model: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  requireProviderApiKey(provider: ProviderName): void {
    if (this.ctx.config.providers[provider]?.apiKey) return;
    throw new Error(
      `No ${provider} API key is configured. Run ` +
        `easy-code config set ${apiKeyConfigKey(provider)} (saved to the system credential store), then restart EASY CODE.`,
    );
  }
}
