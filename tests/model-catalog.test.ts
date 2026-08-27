import assert from "node:assert/strict";

import {
  DEFAULT_MODEL_IDS,
  PROVIDER_CATALOG,
  modelsForProvider,
  modelVisionSupport,
  requireVisionModel,
  requireCatalogModel,
  resolveCatalogModel,
  validateProviderImageAttachments,
} from "../src/models/catalog.js";
import {
  THINKING_EFFORT_STEP_LIMITS,
  thinkingEffortIsApplied,
  thinkingEffortStepLimit,
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
      ],
    );
    assert.deepEqual(
      modelsForProvider("deepseek").map((model) => model.id),
      [
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-v4-flash-vision-exp",
      ],
    );
    assert.deepEqual(
      modelsForProvider("qwen").map((model) => model.id),
      [
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-max",
        "qwen3.6-plus",
        "qwen3.5-plus",
        "qwen3.5-flash",
        "qwen3-max",
        "qwen3-vl-plus",
        "qwen3-vl-flash",
      ],
    );
    assert.deepEqual(
      modelsForProvider("glm").map((model) => model.id),
      ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
    );
    assert.deepEqual(DEFAULT_MODEL_IDS, {
      qwen: "qwen3.7-max",
      deepseek: "deepseek-v4-pro",
      glm: "glm-5.3",
    });
  });

  it("uses an explicit conservative vision capability matrix", () => {
    assert.equal(
      modelVisionSupport("deepseek", "deepseek-v4-flash-vision-exp"),
      "supported",
    );
    assert.equal(modelVisionSupport("deepseek", "deepseek-v4-pro"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3-vl-plus"), "supported");
    assert.equal(modelVisionSupport("qwen", "qwen3-max"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3.7-max"), "unsupported");
    assert.equal(modelVisionSupport("qwen", "qwen3.6-max"), "unsupported");
    assert.equal(modelVisionSupport("glm", "glm-5.3-flash"), "supported");
    assert.equal(modelVisionSupport("glm", "glm-5.3"), "unsupported");
    assert.equal(modelVisionSupport("glm", "glm-5.2"), "unsupported");
    assert.throws(
      () => requireVisionModel("qwen", "qwen3.7-max"),
      /text-only/u,
    );
    assert.doesNotThrow(() => requireVisionModel("qwen", "qwen3-vl-flash"));
    assert.doesNotThrow(() => requireVisionModel("glm", "GLM-5.3-Flash"));
    assert.throws(() => requireVisionModel("glm", "GLM-5.3"), /text-only/u);
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
      thinkingRequestParameters("deepseek", "deepseek-v4-pro", "medium"),
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    );
    assert.deepEqual(
      thinkingRequestParameters("deepseek", "deepseek-v4-flash", "none"),
      { thinking: { type: "disabled" } },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.3-flash", "low"),
      { thinking: { type: "enabled" }, reasoning_effort: "low" },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.3", "medium"),
      { thinking: { type: "enabled" }, reasoning_effort: "high" },
    );
    assert.deepEqual(
      thinkingRequestParameters("glm", "glm-5.2", "none"),
      { thinking: { type: "disabled" } },
    );

    assert.deepEqual(
      thinkingRequestParameters("qwen", "qwen3.6-max", "high"),
      {},
    );
    assert.deepEqual(
      thinkingRequestParameters(
        "deepseek",
        "deepseek-v4-flash-vision-exp",
        "high",
      ),
      {},
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
      thinkingEffortIsApplied("qwen", "qwen3.6-max", "high"),
      false,
    );
  });

  it("maps thinking effort to the agent step budget", () => {
    assert.deepEqual(THINKING_EFFORT_STEP_LIMITS, {
      none: 40,
      low: 40,
      medium: 80,
      high: 120,
    });
    assert.equal(thinkingEffortStepLimit("none"), 40);
    assert.equal(thinkingEffortStepLimit("low"), 40);
    assert.equal(thinkingEffortStepLimit("medium"), 80);
    assert.equal(thinkingEffortStepLimit("high"), 120);
    assert.equal(thinkingEffortStepLimit("high", 60), 60);
    assert.equal(thinkingEffortStepLimit("low", 200), 40);
  });

  it("canonicalizes labels and rejects cross-provider or unknown model IDs", () => {
    assert.equal(resolveCatalogModel("qwen", "Qwen3-VL-Flash")?.id, "qwen3-vl-flash");
    assert.equal(requireCatalogModel("deepseek", "DEEPSEEK-V4-PRO").id, "deepseek-v4-pro");
    assert.equal(resolveCatalogModel("glm", "GLM-5.3-Flash")?.id, "glm-5.3-flash");
    assert.throws(
      () => requireCatalogModel("qwen", "deepseek-v4-pro"),
      /not in the Alibaba Qwen catalog/u,
    );
    assert.throws(
      () => requireCatalogModel("deepseek", "unknown-model"),
      /Supported models:/u,
    );
    assert.throws(
      () => requireCatalogModel("glm", "qwen3-vl-plus"),
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
