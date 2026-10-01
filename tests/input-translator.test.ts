import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { InputTranslator, VSCODE_IMAGE_PASTE_SEQUENCE } from "../src/ui/ink/input-translator.js";
import { describe, it } from "./harness.js";

async function translate(chunks: readonly string[]): Promise<{ output: string; focus: boolean[] }> {
  const source = new PassThrough();
  const focus: boolean[] = [];
  const translator = new InputTranslator(source as unknown as NodeJS.ReadStream, (focused) => focus.push(focused));
  let output = "";
  translator.on("data", (chunk: string) => {
    output += chunk;
  });
  for (const chunk of chunks) {
    source.write(chunk);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 90));
  translator.release();
  return { output, focus };
}

describe("Ink input translator", () => {
  it("takes terminal focus reports out of the key stream", async () => {
    const result = await translate(["a\u001B[Ob", "\u001B[Ic"]);
    assert.equal(result.output, "abc");
    assert.deepEqual(result.focus, [false, true]);
  });

  it("reassembles a focus report split across chunks and leaves arrow keys alone", async () => {
    const result = await translate(["x\u001B", "[O\u001B[A"]);
    assert.equal(result.output, "x\u001B[A");
    assert.deepEqual(result.focus, [false]);
  });

  it("still turns the VS Code paste request into Ctrl+V", async () => {
    const result = await translate([`a${VSCODE_IMAGE_PASTE_SEQUENCE}b`]);
    assert.equal(result.output, "a\u0016b");
    assert.deepEqual(result.focus, []);
  });
});
