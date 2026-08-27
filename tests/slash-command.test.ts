import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import {
  HELP_TEXT,
  parseModelCommand,
  parseSlashCommand,
} from "../src/cli/slash-command.js";

describe("parseSlashCommand", () => {
  it("parses a command and arguments", () => {
    assert.deepEqual(parseSlashCommand(" /mode code "), {
      name: "mode",
      args: ["code"],
      rawArgs: "code"
    });
  });

  it("returns null for normal prompts", () => {
    assert.equal(parseSlashCommand("fix the bug"), null);
  });

  it("parses model inspection and provider-aware switching", () => {
    assert.deepEqual(parseModelCommand([]), { action: "show" });
    assert.deepEqual(parseModelCommand(["qwen3-coder-plus"]), {
      action: "switch",
      model: "qwen3-coder-plus",
    });
    assert.throws(
      () => parseModelCommand(["DEEPSEEK"]),
      /Usage: \/model/u,
    );
    assert.deepEqual(parseModelCommand(["qwen", "qwen-custom"]), {
      action: "switch",
      provider: "qwen",
      model: "qwen-custom",
    });
    assert.throws(
      () => parseModelCommand(["unknown-provider", "model"]),
      /Usage: \/model/u,
    );
    assert.throws(
      () => parseModelCommand(["qwen", "model", "extra"]),
      /Usage: \/model/u,
    );
  });

  it("documents the model command", () => {
    assert.match(HELP_TEXT, /\/model/u);
  });
});
