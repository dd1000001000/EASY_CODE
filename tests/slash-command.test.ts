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

  it("parses model selection and provider-aware direct switching", () => {
    assert.deepEqual(parseModelCommand([]), { action: "select" });
    assert.deepEqual(parseModelCommand(["qwen3.7-plus"]), {
      action: "switch",
      model: "qwen3.7-plus",
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
    assert.deepEqual(parseModelCommand(["glm", "GLM-5.3-Flash"]), {
      action: "switch",
      provider: "glm",
      model: "GLM-5.3-Flash",
    });
    assert.throws(() => parseModelCommand(["glm"]), /Usage: \/model/u);
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
    assert.match(HELP_TEXT, /qwen\|deepseek\|glm/u);
    assert.match(HELP_TEXT, /\/thinking \[id\|last\]/u);
    assert.match(HELP_TEXT, /\/agents/u);
    assert.match(HELP_TEXT, /child sessions, tasks, isolation, and handoff/u);
    assert.match(HELP_TEXT, /\/memory short \[limit\]/u);
    assert.match(HELP_TEXT, /\/usage/u);
    assert.match(HELP_TEXT, /\/approval/u);
    assert.match(HELP_TEXT, /dangerous full-host access/u);
  });
});
