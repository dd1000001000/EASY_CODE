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
import { describe, it } from "./harness.js";

describe("model catalog", () => {
  it("contains the exact provider order and supported model IDs", () => {
    assert.deepEqual(
      PROVIDER_CATALOG.map(({ provider, label }) => ({ provider, label })),
      [
        { provider: "deepseek", label: "DeepSeek" },
        { provider: "qwen", label: "Alibaba Qwen" },
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
    assert.deepEqual(DEFAULT_MODEL_IDS, {
      qwen: "qwen3.7-max",
      deepseek: "deepseek-v4-pro",
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
    assert.throws(
      () => requireVisionModel("qwen", "qwen3.7-max"),
      /text-only/u,
    );
    assert.doesNotThrow(() => requireVisionModel("qwen", "qwen3-vl-flash"));
  });

  it("canonicalizes labels and rejects cross-provider or unknown model IDs", () => {
    assert.equal(resolveCatalogModel("qwen", "Qwen3-VL-Flash")?.id, "qwen3-vl-flash");
    assert.equal(requireCatalogModel("deepseek", "DEEPSEEK-V4-PRO").id, "deepseek-v4-pro");
    assert.throws(
      () => requireCatalogModel("qwen", "deepseek-v4-pro"),
      /not in the Alibaba Qwen catalog/u,
    );
    assert.throws(
      () => requireCatalogModel("deepseek", "unknown-model"),
      /Supported models:/u,
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
