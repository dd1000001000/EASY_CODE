import assert from "node:assert/strict";

import {
  AdjustmentRegistry,
  renderAdjustmentBody,
  renderAdjustmentMarker,
  renderAdjustmentPanel,
} from "../src/cli/adjustment.js";
import type { ImageAttachment } from "../src/core/types.js";
import { describe, it } from "./harness.js";

function attachment(index: number): ImageAttachment {
  return {
    id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    label: `Image #${index}`,
    mediaType: "image/png",
    storageKey: `attachments/test/adjustment-${index}.png`,
    sha256: String(index % 10).repeat(64),
    byteSize: 68,
    width: 1,
    height: 1,
  };
}

describe("queued adjustment terminal presentation", () => {
  it("retains every adjustment and does not duplicate inline image labels", () => {
    const registry = new AdjustmentRegistry();
    const first = registry.add(
      1,
      "Compare [Image #1] with the current implementation.",
      [attachment(1)],
    );

    for (const rendered of [
      renderAdjustmentMarker(first),
      renderAdjustmentPanel(first),
      renderAdjustmentBody(first),
    ]) {
      assert.equal(
        (rendered.match(/\[Image #1\]/gu) ?? []).length,
        1,
      );
    }

    for (let id = 2; id <= 300; id += 1) {
      registry.add(id, `adjustment ${id}`);
    }
    assert.equal(registry.get(1)?.text, first.text);
  });
});
