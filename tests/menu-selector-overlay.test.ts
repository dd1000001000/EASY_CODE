import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  renderMenu,
  selectMenuIndex,
  type MenuNavigationDirection,
  type MenuSelectorOverlay,
} from "../src/cli/menu-selector.js";
import { describe, it } from "./harness.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModeTransitions: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeTransitions.push(mode);
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
}

class RecordingOverlay implements MenuSelectorOverlay {
  readonly frames: string[][] = [];
  clearCount = 0;

  render(lines: string[]): void {
    this.frames.push([...lines]);
  }

  clear(): void {
    this.clearCount += 1;
  }
}

function captureOutput(output: PassThrough): () => string {
  let transcript = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return () => transcript;
}

function selectWithOverlay(
  input: TtyInput,
  output: TtyOutput,
  overlay: MenuSelectorOverlay,
): Promise<number | undefined> {
  const rows = ["First", "Second", "Third"];
  return selectMenuIndex(
    rows.length,
    1,
    (selectedIndex) => renderMenu("Choose", rows, selectedIndex, false),
    { input, output, overlay, color: false },
    "No choices.",
  );
}

describe("menu selector overlay renderer", () => {
  it("renders initial and changed selections in the overlay without writing terminal controls", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const overlay = new RecordingOverlay();

    const selection = selectWithOverlay(input, output, overlay);
    input.write("\u001B[B\r");

    assert.equal(await selection, 2);
    assert.equal(overlay.frames.length, 2);
    assert.match(overlay.frames[0]?.[2] ?? "", /› Second/u);
    assert.match(overlay.frames[1]?.[3] ?? "", /› Third/u);
    assert.equal(overlay.clearCount, 1);
    assert.equal(transcript(), "");
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.equal(input.readableFlowing, false);
  });

  it("owns raw input before the first visible overlay frame", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    let firstRender = true;
    const overlay: MenuSelectorOverlay = {
      render: () => {
        if (!firstRender) return;
        firstRender = false;
        // Model a terminal that delivers the user's first key as soon as the
        // approval card is painted. Both bytes must reach this selector.
        input.write("\u001B[B\r");
      },
      clear: () => undefined,
    };

    const selection = selectWithOverlay(input, output, overlay);

    assert.equal(await selection, 2);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
  });

  it("clears the overlay and restores input state when cancelled", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const overlay = new RecordingOverlay();

    input.resume();
    const selection = selectWithOverlay(input, output, overlay);
    input.write("\u0003");

    assert.equal(await selection, undefined);
    assert.equal(overlay.frames.length, 1);
    assert.equal(overlay.clearCount, 1);
    assert.equal(transcript(), "");
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.equal(input.readableFlowing, true);
  });

  it("accepts out-of-band navigation without writing a terminal key", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const overlay = new RecordingOverlay();
    let navigate: ((direction: MenuNavigationDirection) => void) | undefined;
    let active = false;

    const rows = ["First", "Second", "Third"];
    const selection = selectMenuIndex(
      rows.length,
      0,
      (selectedIndex) => renderMenu("Choose", rows, selectedIndex, false),
      {
        input,
        output,
        overlay,
        color: false,
        navigation: {
          activate: (listener) => {
            active = true;
            navigate = listener;
            return () => {
              active = false;
              navigate = undefined;
            };
          },
        },
      },
      "No choices.",
    );

    assert.equal(active, true);
    navigate?.("down");
    assert.match(overlay.frames.at(-1)?.[2] ?? "", /› Second/u);
    assert.equal(transcript(), "", "navigation must not be routed through stdout");
    input.write("\r");
    assert.equal(await selection, 1);
    assert.equal(active, false);
    assert.equal(navigate, undefined);
  });
});
