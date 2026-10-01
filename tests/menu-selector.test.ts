import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { renderMenu, selectMenuIndex, type MenuNavigationDirection } from "../src/cli/menu-selector.js";
import { stripAnsi } from "../src/ui/render/layout.js";
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

function captureOutput(output: PassThrough): () => string {
  let transcript = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return () => transcript;
}

/** Whether the menu has painted a frame (anything besides the cursor-hide control). */
function menuVisible(transcript: string): boolean {
  return stripAnsi(transcript).trim().length > 0;
}

function select(input: TtyInput, output: TtyOutput): Promise<number | undefined> {
  const rows = ["First", "Second", "Third"];
  return selectMenuIndex(
    rows.length,
    1,
    (selectedIndex) => renderMenu("Choose", rows, selectedIndex, false),
    { input, output, color: false },
    "No choices.",
  );
}

describe("menu selector", () => {
  it("redraws the selection in place and restores input state", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);

    const selection = select(input, output);
    input.write("\u001B[B\r");

    assert.equal(await selection, 2);
    const rendered = stripAnsi(transcript());
    assert.match(rendered, /› Second/u);
    assert.match(rendered, /› Third/u);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.equal(input.readableFlowing, false);
  });

  it("owns raw input before the first visible frame", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    let delivered = false;
    output.on("data", (chunk: Buffer) => {
      if (delivered || !menuVisible(chunk.toString("utf8"))) return;
      delivered = true;
      // Model a terminal that delivers the user's first key as soon as the
      // menu is painted. Both bytes must reach this selector.
      input.write("\u001B[B\r");
    });

    assert.equal(await select(input, output), 2);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
  });

  it("restores a flowing input when cancelled", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();

    input.resume();
    const selection = select(input, output);
    input.write("\u0003");

    assert.equal(await selection, undefined);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.equal(input.readableFlowing, true);
  });

  it("accepts out-of-band navigation without reading a terminal key", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
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
        color: false,
        navigation: {
          activate: (listener) => {
            active = true;
            navigate = listener;
            return {
              release: () => {
                active = false;
                navigate = undefined;
              },
            };
          },
        },
      },
      "No choices.",
    );

    assert.equal(active, true);
    navigate?.("down");
    assert.match(stripAnsi(transcript()), /› Second/u);
    input.write("\r");
    assert.equal(await selection, 1);
    assert.equal(active, false);
    assert.equal(navigate, undefined);
  });

  it("does not expose the menu until host navigation is ready", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    let acknowledge: ((ready: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });

    const rows = ["First", "Second"];
    const selection = selectMenuIndex(
      rows.length,
      0,
      (selectedIndex) => renderMenu("Choose", rows, selectedIndex, false),
      {
        input,
        output,
        navigation: {
          activate: () => ({ ready, release: () => undefined }),
        },
      },
      "No choices.",
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(menuVisible(transcript()), false);
    assert.equal(input.isRaw, true);
    let settled = false;
    void selection.then(() => {
      settled = true;
    });
    input.write("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    acknowledge?.(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(menuVisible(transcript()), true);
    input.write("\r");
    assert.equal(await selection, 0);
  });

  it("starts an unattended choice timeout only after the menu is visible", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    let acknowledge: ((ready: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });
    const selection = selectMenuIndex(
      2,
      1,
      (index) => renderMenu("Choose", ["Allow once", "Reject"], index, false),
      {
        input,
        output,
        navigation: { activate: () => ({ ready, release: () => undefined }) },
        idleTimeoutMs: 15,
        idleSelectionIndex: 0,
      },
      "No choices.",
    );
    let settled = false;
    void selection.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    assert.equal(menuVisible(transcript()), false);
    acknowledge?.(true);
    assert.equal(await selection, 0);
  });
});
