import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES,
  DEFAULT_MODEL_IDS,
  PROVIDER_CATALOG,
  activateInstalledModelCatalog,
  modelsForProvider,
  modelVisionSupport,
  parseModelCatalog,
  providerApiKeyEnvironmentVariables,
  providerCatalogEntry,
  providerCredentialConfigKey,
  providerEnvironment,
  requireVisionModel,
  requireCatalogModel,
  resolveCatalogModel,
  sweBenchVerified50Profile,
  validateProviderImageAttachments,
} from "../src/models/catalog.js";
import {
  THINKING_EFFORT_BUDGET_MULTIPLIERS,
  THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS,
  THINKING_EFFORT_STEP_LIMITS,
  thinkingEffortBudget,
  thinkingEffortContextCharLimit,
  thinkingEffortIsApplied,
  thinkingEffortStepLimit,
  thinkingEffortTimeoutMs,
  thinkingRequestParameters,
} from "../src/models/thinking.js";
import { describe, it } from "./harness.js";

describe("model catalog", () => {
  it("contains the exact provider order and supported model IDs", () => {
    assert.deepEqual(
      PROVIDER_CATALOG.map(({ provider, label }) => ({ provider, label })),
      [
        { provider: "deepseek", label: "DeepSeek" },
        { provider: "qwen", label: "Alibaba Qwen" },
        { provider: "glm", label: "Zhipu GLM" },
        { provider: "glm-coding-plan", label: "GLM Coding Plan" },
      ],
    );
    assert.deepEqual(
      modelsForProvider("deepseek").map((model) => model.id),
      [
        "deepseek-flash",
      ],
    );
    assert.deepEqual(
      modelsForProvider("qwen").map((model) => model.id),
      [
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.7-flash",
        "qwen3-coder-plus",
        "qwen3-coder-flash",
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3.5-plus",
        "qwen3.5-flash",
      ],
    );
    assert.deepEqual(
      modelsForProvider("glm").map((model) => model.id),
      ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
    );
    assert.deepEqual(
      modelsForProvider("glm-coding-plan").map((model) => model.id),
      ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
    );
    assert.deepEqual(DEFAULT_MODEL_IDS, {
      qwen: "qwen3.7-max",
      deepseek: "deepseek-flash",
      glm: "glm-5.3",
      "glm-coding-plan": "glm-5.3",
    });
  });

  it("derives provider ownership, endpoints, adapters, credentials, and profiles from one catalog", () => {
    assert.deepEqual(
      PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        vendor: entry.vendor,
        adapter: entry.adapter,
        configKey: entry.configKey,
      })),
      [
        { provider: "deepseek", vendor: "DeepSeek", adapter: "deepseek", configKey: "deepseek.api-key" },
        { provider: "qwen", vendor: "Alibaba Cloud", adapter: "qwen", configKey: "qwen.api-key" },
        { provider: "glm", vendor: "Zhipu AI", adapter: "glm", configKey: "glm.api-key" },
        { provider: "glm-coding-plan", vendor: "Zhipu AI", adapter: "glm", configKey: "glm-coding-plan.api-key" },
      ],
    );
    assert.equal(
      providerCatalogEntry("glm-coding-plan").defaultBaseUrl,
      "https://open.bigmodel.cn/api/coding/paas/v4",
    );
    assert.equal(providerCredentialConfigKey("glm"), "glm.api-key");
    assert.deepEqual(providerApiKeyEnvironmentVariables("qwen"), [
      "QWEN_API_KEY",
      "DASHSCOPE_API_KEY",
    ]);
    assert.deepEqual(sweBenchVerified50Profile(), {
      provider: "glm-coding-plan",
      model: "glm-5.3-flash",
      mode: "code",
      thinkingEffort: "high",
    });
    assert.equal(new Set(ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES).size, 7);
  });

  it("excludes the removed sub-1M Qwen models without adding a preview alias", () => {
    const models = PROVIDER_CATALOG.flatMap((entry) => entry.models);
    assert.equal(models.length, 18);
    assert.equal(new Set(models.map((model) => model.id)).size, 15);
    for (const model of [
      "qwen3.6-max",
      "qwen3.6-max-preview",
      "qwen3-max",
      "qwen3-vl-plus",
      "qwen3-vl-flash",
    ]) {
      assert.equal(resolveCatalogModel("qwen", model), undefined);
      assert.throws(
        () => requireCatalogModel("qwen", model),
        /not in the Alibaba Qwen catalog/u,
      );
      assert.equal(modelVisionSupport("qwen", model), "unknown");
    }
  });

  it("keeps every standard GLM environment setting isolated from Coding Plan", () => {
    const standard = providerEnvironment("glm");
    const plan = providerEnvironment("glm-coding-plan");
    for (const field of ["apiKey", "baseUrl", "model", "timeoutMs", "maxRetries"] as const) {
      assert.deepEqual(
        standard[field].filter((name) => plan[field].includes(name)),
        [],
      );
    }
  });

  it("activates only the exact built catalog and rejects malformed or overlapping metadata", async () => {
    const source = await readFile(
      path.resolve("resources", "prompt-bundle", "models", "catalog.json"),
      "utf8",
    );
    assert.doesNotThrow(() => activateInstalledModelCatalog(source));
    assert.throws(
      () => activateInstalledModelCatalog(`${source}\n`),
      /hash mismatch/u,
    );

    const invalid = JSON.parse(source) as {
      providers: Array<{
        id: string;
        environment: { model: string[] };
      }>;
    };
    const plan = invalid.providers.find((entry) => entry.id === "glm-coding-plan");
    assert.ok(plan);
    plan.environment.model.push("GLM_MODEL");
    assert.throws(
      () => parseModelCatalog(invalid),
      /overlaps Coding Plan/u,
    );
  });

  it("uses an explicit conservative vision capability matrix", () => {
    assert.equal(
      modelVisionSupport("deepseek", "deepseek-flash"),
      "supported",
    );
    assert.equal(modelVisionSupport("deepseek", "deepseek-v4-pro"), "unknown");
    assert.doesNotThrow(() => requireVisionModel("deepseek", "deepseek-flash"));
    assert.equal(resolveCatalogModel("deepseek", "deepseek-flash")?.contextWindowTokens, 1_000_000);
    for (const retired of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      assert.throws(() => requireCatalogModel("deepseek", retired), /not in the/u);
    }
    assert.equal(modelVisionSupport("qwen", "qwen3.7-plus"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3.7-max"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3.8-max"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3.8-flash"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3.7-flash"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3-coder-plus"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3-coder-flash"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3.6-plus"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3.6-flash"), "supported");
    assert.equal(modelVisionSupport("glm", "glm-5.3-flash"), "supported");
    assert.equal(modelVisionSupport("glm", "glm-5.3"), "unsupported");
    assert.equal(modelVisionSupport("glm", "glm-5.2"), "unsupported");
    assert.equal(
      modelVisionSupport("glm-coding-plan", "glm-5.3-flash"),
      "unsupported",
    );
    assert.equal(
      modelVisionSupport("glm-coding-plan", "glm-5.3"),
      "unsupported",
    );
    assert.equal(
      modelVisionSupport("glm-coding-plan", "glm-5.2"),
      "unsupported",
    );
    assert.throws(
      () => requireVisionModel("qwen", "qwen3.7-max"),
      /text-only/u,
    );
    assert.doesNotThrow(() => requireVisionModel("qwen", "qwen3.5-flash"));
    assert.doesNotThrow(() => requireVisionModel("glm", "GLM-5.3-Flash"));
    assert.throws(() => requireVisionModel("glm", "GLM-5.3"), /text-only/u);
    assert.throws(
      () => requireVisionModel("glm-coding-plan", "GLM-5.3-Flash"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /text-only/u);
        assert.match(error.message, /switch to a provider/iu);
        assert.doesNotMatch(error.message, /\/model:\s*$/u);
        return true;
      },
    );
  });

  it("maps the normalized thinking effort only for documented model profiles", () => {
    assert.deepEqual(
      thinkingRequestParameters("qwen", "qwen3.7-max", "none"),
      { enable_thinking: false },
    );
    assert.deepEqual(
      ["low", "medium", "high"].map((effort) =>
        thinkingRequestParameters(
          "qwen",
          "qwen3.7-max",
          effort as "low" | "medium" | "high",
        )),
      [
        { enable_thinking: true, thinking_budget: 4_096 },
        { enable_thinking: true, thinking_budget: 16_384 },
        { enable_thinking: true, thinking_budget: 32_768 },
      ],
    );
    assert.deepEqual(
      thinkingRequestParameters("deepseek", "deepseek-flash", "medium"),
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    );
    assert.deepEqual(
      thinkingRequestParameters("deepseek", "deepseek-flash", "none"),
      { thinking: { type: "disabled" } },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.3-flash", "low"),
      { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "low" },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.3", "medium"),
      { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high" },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.2", "none"),
      { thinking: { type: "disabled" } },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm-coding-plan", "glm-5.3-flash", "high"),
      { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high" },
    );

    assert.deepEqual(
      thinkingRequestParameters("qwen", "unknown-model", "high"),
      {},
    );
    assert.deepEqual(
      thinkingRequestParameters(
        "deepseek",
        "deepseek-flash",
        "high",
      ),
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    );
    assert.equal(
      thinkingEffortIsApplied("glm", "glm-5.3", "none"),
      false,
    );
    assert.equal(
      thinkingEffortIsApplied("glm", "glm-5.3", "low"),
      true,
    );
    assert.equal(
      thinkingEffortIsApplied("qwen", "unknown-model", "high"),
      false,
    );
  });

  it("scales step budgets while keeping one compaction limit for every effort", () => {
    assert.deepEqual(THINKING_EFFORT_BUDGET_MULTIPLIERS, {
      none: 1,
      low: 1,
      medium: 1,
      high: 2,
    });
    assert.deepEqual(THINKING_EFFORT_STEP_LIMITS, {
      none: 40,
      low: 40,
      medium: 40,
      high: 80,
    });
    assert.deepEqual(THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS, {
      none: 1,
      low: 1,
      medium: 1,
      high: 1,
    });
    assert.equal(thinkingEffortStepLimit("none"), 40);
    assert.equal(thinkingEffortStepLimit("low"), 40);
    assert.equal(thinkingEffortStepLimit("medium"), 40);
    assert.equal(thinkingEffortStepLimit("high"), 80);
    assert.equal(thinkingEffortContextCharLimit("none"), 250_000);
    assert.equal(thinkingEffortContextCharLimit("low"), 250_000);
    assert.equal(thinkingEffortContextCharLimit("medium"), 250_000);
    assert.equal(thinkingEffortContextCharLimit("high"), 250_000);
  });

  it("scales custom none/low bases and rejects invalid or overflowing budgets", () => {
    assert.equal(thinkingEffortStepLimit("none", 25), 25);
    assert.equal(thinkingEffortStepLimit("low", 25), 25);
    assert.equal(thinkingEffortStepLimit("medium", 25), 25);
    assert.equal(thinkingEffortStepLimit("high", 25), 50);
    assert.equal(thinkingEffortContextCharLimit("medium", 123_456), 123_456);
    assert.equal(thinkingEffortContextCharLimit("high", 123_456), 123_456);

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => thinkingEffortBudget("low", invalid),
        /positive safe integer/u,
      );
    }
    assert.throws(
      () => thinkingEffortBudget("high", Number.MAX_SAFE_INTEGER),
      /exceeds the safe integer range/u,
    );
    assert.throws(
      () => thinkingEffortContextCharLimit("high", 0),
      /positive safe integer/u,
    );
  });

  it("selects provider request timeouts by thinking effort", () => {
    assert.equal(thinkingEffortTimeoutMs("none"), 300_000);
    assert.equal(thinkingEffortTimeoutMs("low"), 300_000);
    assert.equal(thinkingEffortTimeoutMs("medium"), 450_000);
    assert.equal(thinkingEffortTimeoutMs("high"), 600_000);
  });

  it("canonicalizes labels and rejects cross-provider or unknown model IDs", () => {
    assert.equal(resolveCatalogModel("qwen", "Qwen3.5-Flash")?.id, "qwen3.5-flash");
    assert.equal(requireCatalogModel("deepseek", "DEEPSEEK-FLASH").id, "deepseek-flash");
    assert.equal(requireCatalogModel("deepseek", "deepseek v4.1-flash").id, "deepseek-flash");
    assert.equal(resolveCatalogModel("glm", "GLM-5.3-Flash")?.id, "glm-5.3-flash");
    assert.throws(
      () => requireCatalogModel("qwen", "deepseek-flash"),
      /not in the Alibaba Qwen catalog/u,
    );
    assert.throws(
      () => requireCatalogModel("deepseek", "unknown-model"),
      /Supported models:/u,
    );
    assert.throws(
      () => requireCatalogModel("glm", "qwen3.7-plus"),
      /not in the Zhipu GLM catalog/u,
    );
  });

  it("enforces Alibaba Qwen's documented image shape and format limits", () => {
    const image = {
      id: "image_00000000-0000-4000-8000-000000000001",
      label: "Image #1",
      mediaType: "image/png" as const,
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000001.png",
      sha256: "0".repeat(64),
      byteSize: 128,
      width: 16,
      height: 16,
    };
    assert.doesNotThrow(() => validateProviderImageAttachments("qwen", [image]));
    assert.throws(
      () => validateProviderImageAttachments("qwen", [{ ...image, width: 10 }]),
      /larger than 10x10/u,
    );
    assert.throws(
      () => validateProviderImageAttachments("qwen", [{
        ...image,
        mediaType: "image/gif",
        storageKey: image.storageKey.replace(/\.png$/u, ".gif"),
      }]),
      /does not accept/u,
    );
    assert.doesNotThrow(() =>
      validateProviderImageAttachments("deepseek", [{ ...image, width: 1, height: 1 }]),
    );
  });
});
