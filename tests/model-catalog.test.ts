import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ACTIVE_MODEL_REGISTRY_HASH,
  ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES,
  DEFAULT_MODEL_IDS,
  PACKAGED_MODEL_REGISTRY_SOURCE,
  PROVIDER_CATALOG,
  activateModelRegistry,
  ensureUserModelRegistry,
  modelVisionSupport,
  modelsForProvider,
  parseModelCatalog,
  providerCatalogEntry,
  requireCatalogModel,
  validateProviderImageAttachments,
} from "../src/models/catalog.js";
import {
  THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS,
  thinkingEffortBudget,
  thinkingEffortContextCharLimit,
  thinkingEffortIsApplied,
  thinkingRequestParameters,
} from "../src/models/thinking.js";
import { helpText, parseModelCommand } from "../src/cli/slash-command.js";
import { describe, it } from "./harness.js";

describe("user model registry", () => {
  it("loads providers, models, capabilities, endpoints and benchmark profile from TOML", () => {
    assert.deepEqual(PROVIDER_CATALOG.map((entry) => entry.provider), [
      "qwen", "deepseek", "kimi", "glm", "glm-coding-plan",
    ]);
    assert.equal(providerCatalogEntry("kimi").wireApi, "chat_completions");
    assert.equal(providerCatalogEntry("kimi").supportsTemperature, false);
    assert.equal(providerCatalogEntry("glm").supportsStrictTools, false);
    assert.equal(DEFAULT_MODEL_IDS.qwen, "qwen3.7-max");
    assert.equal(modelsForProvider("kimi")[0]?.id, "k3");
    assert.equal(modelVisionSupport("qwen", "qwen3-coder-plus"), "unsupported");
    assert.ok(ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES.includes("KIMI_API_KEY"));
    assert.match(ACTIVE_MODEL_REGISTRY_HASH, /^sha256:[a-f0-9]{64}$/u);
  });

  it("accepts a new Responses provider without a code change", () => {
    const source = `schema_version = 1
default_model = "custom-default"
[providers.custom]
name = "Custom"
base_url = "https://models.example/v1"
env_key = "CUSTOM_API_KEY"
wire_api = "responses"
[models.custom-default]
name = "Custom Coder"
provider = "custom"
model = "coder-1"
context_window = 131072
input_modalities = ["text", "image"]
tool_calling = true
reasoning = true
`;
    const parsed = parseModelCatalog(source);
    assert.equal(parsed.providers[0]?.wireApi, "responses");
    assert.equal(parsed.providers[0]?.models[0]?.id, "coder-1");
    assert.equal(parsed.providers[0]?.models[0]?.vision, "supported");
    try {
      activateModelRegistry(source, "custom test registry");
      assert.deepEqual(parseModelCommand(["custom", "coder-1"]), {
        action: "switch",
        provider: "custom",
        model: "coder-1",
      });
      assert.match(helpText(), /custom/u);
      assert.doesNotMatch(helpText(), /qwen\|deepseek/u);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
    }
  });

  it("rejects unknown fields, unknown providers, insecure endpoints and duplicate wire ids", () => {
    assert.throws(() => parseModelCatalog(PACKAGED_MODEL_REGISTRY_SOURCE.replace(
      'wire_api = "chat_completions"',
      'wire_api = "unknown"',
    )), /wire_api/u);
    assert.throws(() => parseModelCatalog(PACKAGED_MODEL_REGISTRY_SOURCE.replace(
      'base_url = "https://api.deepseek.com"',
      'base_url = "http://api.deepseek.com"',
    )), /base_url/u);
    assert.throws(() => parseModelCatalog(PACKAGED_MODEL_REGISTRY_SOURCE.replace(
      'provider = "deepseek"',
      'provider = "missing"',
    )), /unknown provider/u);
  });

  it("creates the fixed user file once and never overwrites it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-model-registry-"));
    const registryPath = path.join(root, ".easy_code", "models.toml");
    try {
      await ensureUserModelRegistry(registryPath);
      const installed = await readFile(registryPath, "utf8");
      assert.equal(installed, PACKAGED_MODEL_REGISTRY_SOURCE);
      const customized = installed.replace('name = "Kimi Coding Plan"', 'name = "My Kimi"');
      await writeFile(registryPath, customized, "utf8");
      await ensureUserModelRegistry(registryPath);
      assert.equal(await readFile(registryPath, "utf8"), customized);
    } finally {
      activateModelRegistry(PACKAGED_MODEL_REGISTRY_SOURCE, "packaged test registry");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit provider-specific thinking fields for Chat Completions", () => {
    assert.deepEqual(thinkingRequestParameters("qwen", "qwen3.7-max", "high"), {});
    assert.equal(thinkingEffortIsApplied("qwen", "qwen3.7-max", "high"), false);
    assert.deepEqual(THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS, { none: 1, low: 1, medium: 1, high: 1 });
    assert.equal(thinkingEffortContextCharLimit("high"), 250_000);
    assert.equal(thinkingEffortBudget("high", 25), 50);
  });

  it("resolves model aliases and retains provider-specific image constraints", () => {
    assert.equal(requireCatalogModel("deepseek", "deepseek-default").id, "deepseek-flash");
    const image = {
      id: "image_00000000-0000-4000-8000-000000000001",
      label: "Image #1",
      mediaType: "image/png" as const,
      storageKey: "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000001.png",
      sha256: "0".repeat(64), byteSize: 128, width: 16, height: 16,
    };
    assert.doesNotThrow(() => validateProviderImageAttachments("qwen", [image]));
    assert.throws(() => validateProviderImageAttachments("qwen", [{ ...image, width: 10 }]), /at least 11 pixels wide/u);
  });
});
