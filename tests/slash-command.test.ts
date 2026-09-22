import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import {
  completeSlashCommandPrefix,
  helpText,
  parseModelCommand,
  parseSlashCommand,
  SLASH_COMMAND_NAMES,
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
    assert.equal(
      parseSlashCommand("/folder 帮我看一下这个文件夹里有什么"),
      null,
    );
    assert.equal(parseSlashCommand("/approv"), null);
  });

  it("does not recognize removed commands or legacy aliases", () => {
    const supported = new Set<string>(SLASH_COMMAND_NAMES);
    for (const name of ["changes", "quit", "subagents", "tasks", "agents", "commands", "thinking", "adjustment"]) {
      assert.equal(parseSlashCommand(`/${name}`), null);
      assert.ok(!supported.has(name));
      assert.equal(completeSlashCommandPrefix(`/${name}`, name.length + 1), undefined);
    }
    assert.doesNotMatch(helpText(), /\/(?:changes|quit|subagents|tasks|agents|commands|thinking|adjustment)(?:\s|$)/mu);
  });

  it("recognizes the MCP server menu", () => {
    assert.equal(parseSlashCommand("/mcp")?.name, "mcp");
    assert.match(helpText(), /\/mcp\s+Manage user MCP servers/u);
    assert.equal(parseSlashCommand("/skills")?.name, "skills");
    assert.match(helpText(), /\/skills\s+Show global and project Skills/u);
  });

  it("recognizes the language command and documents both locales", () => {
    assert.deepEqual(parseSlashCommand("/language zh_cn"), {
      name: "language", args: ["zh_cn"], rawArgs: "zh_cn",
    });
    assert.match(helpText(), /\/language \[en_us\|zh_cn\]/u);
    assert.match(helpText("zh_cn"), /\/language \[en_us\|zh_cn\].*界面语言/u);
  });

  it("offers presentation-only command-name completion", () => {
    assert.deepEqual(completeSlashCommandPrefix("/approv", 7), {
      replacement: "/approval",
      suffix: "al",
    });
    assert.deepEqual(completeSlashCommandPrefix("/m", 2), {
      replacement: "/mcp",
      suffix: "cp",
    });
    assert.equal(completeSlashCommandPrefix("/approv", 3), undefined);
    assert.equal(completeSlashCommandPrefix("/model ", 7), undefined);
    assert.equal(completeSlashCommandPrefix("/folder", 7), undefined);
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
    assert.deepEqual(parseModelCommand(["glm", "GLM-5.3-Flash", "high"]), {
      action: "switch", provider: "glm", model: "GLM-5.3-Flash", thinkingEffort: "high",
    });
    assert.deepEqual(
      parseModelCommand(["kimi", "k3"]),
      {
        action: "switch",
        provider: "kimi",
        model: "k3",
      },
    );
    assert.deepEqual(
      parseModelCommand(["glm-coding-plan", "GLM-5.3-Flash"]),
      {
        action: "switch",
        provider: "glm-coding-plan",
        model: "GLM-5.3-Flash",
      },
    );
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
    const HELP_TEXT = helpText();
    assert.match(HELP_TEXT, /\/model/u);
    assert.match(HELP_TEXT, /qwen\|deepseek\|kimi\|glm\|glm-coding-plan/u);
    assert.match(HELP_TEXT, /\/memory short \[limit\]/u);
    assert.doesNotMatch(HELP_TEXT, /\/memory (?:move|forget)/u);
    assert.match(HELP_TEXT, /\/usage/u);
    assert.match(HELP_TEXT, /\/approval/u);
    assert.match(HELP_TEXT, /full host access/u);
  });
});
