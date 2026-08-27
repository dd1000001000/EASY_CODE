import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import {
  renderStartupModelSelector,
  selectStartupModel,
  type StartupModelChoice,
} from "../src/cli/model-selector.js";
import { Terminal } from "../src/cli/terminal.js";
import type { ApiKeyCredentialStore } from "../src/config/credentials.js";
import type { ProviderName } from "../src/core/types.js";
import { describe, it } from "./harness.js";

const TEST_ENVIRONMENT = [
  "EASY_CODE_CONFIG_DIR",
  "EASY_CODE_DATA_DIR",
  "EASY_CODE_CACHE_DIR",
  "EASY_CODE_PROVIDER",
  "QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "QWEN_MODEL",
  "DEEPSEEK_MODEL",
] as const;

const STARTUP_CHOICES: readonly StartupModelChoice[] = [
  { provider: "qwen", model: "qwen-test-model", apiKeyConfigured: true },
  { provider: "deepseek", model: "deepseek-test-model", apiKeyConfigured: false },
];

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

class MemoryCredentialStore implements ApiKeyCredentialStore {
  readonly values = new Map<ProviderName, string>();
  readonly writes: ProviderName[] = [];

  async get(provider: ProviderName): Promise<string | undefined> {
    return this.values.get(provider);
  }

  async set(provider: ProviderName, value: string): Promise<void> {
    this.writes.push(provider);
    this.values.set(provider, value);
  }

  async delete(provider: ProviderName): Promise<boolean> {
    return this.values.delete(provider);
  }
}

class ScriptedStartupTerminal extends Terminal {
  transcript = "";
  choices: readonly StartupModelChoice[] = [];
  initialProvider?: ProviderName;
  readonly secretPrompts: string[] = [];
  readonly questionPrompts: string[] = [];

  constructor(
    private readonly selection: ProviderName | undefined,
    private readonly secret: string,
  ) {
    super(new PassThrough(), new PassThrough());
  }

  override isInteractive(): boolean {
    return true;
  }

  override async selectStartupModel(
    choices: readonly StartupModelChoice[],
    initialProvider: ProviderName,
  ): Promise<ProviderName | undefined> {
    this.choices = choices;
    this.initialProvider = initialProvider;
    return this.selection;
  }

  override async readSecret(prompt: string): Promise<string> {
    this.secretPrompts.push(prompt);
    return this.secret;
  }

  override async question(prompt: string): Promise<string | null> {
    this.questionPrompts.push(prompt);
    return "/exit";
  }

  override write(text: string): void {
    this.transcript += text;
  }

  override close(): void {
    // The scripted streams do not own external resources.
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

function restoreEnvironment(previous: ReadonlyMap<string, string | undefined>): void {
  for (const name of TEST_ENVIRONMENT) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function withStartupApp(
  terminal: ScriptedStartupTerminal,
  store: MemoryCredentialStore,
  run: (app: EasyCodeApp) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-startup-selector-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const previous = new Map(
    TEST_ENVIRONMENT.map((name) => [name, process.env[name]] as const),
  );
  process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
  process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
  process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
  process.env.EASY_CODE_PROVIDER = "qwen";
  process.env.QWEN_MODEL = "qwen-test-model";
  process.env.DEEPSEEK_MODEL = "deepseek-test-model";
  delete process.env.QWEN_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  let app: EasyCodeApp | undefined;
  try {
    app = await EasyCodeApp.create({
      workspaceRoot: workspace,
      terminal,
      credentialStore: store,
      startupInteraction: "select-model",
    });
    await run(app);
  } finally {
    app?.close();
    restoreEnvironment(previous);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("startup model selector", () => {
  it("renders the selected model in white and every other model in gray", () => {
    const lines = renderStartupModelSelector(STARTUP_CHOICES, 0, true);

    assert.match(lines[1] ?? "", /\u001B\[37m/u);
    assert.match(lines[2] ?? "", /\u001B\[90m/u);
    assert.match(lines[1] ?? "", /› Qwen/u);
    assert.match(lines[2] ?? "", /DeepSeek/u);
  });

  it("neutralizes terminal controls and bidirectional overrides in model names", () => {
    const rendered = renderStartupModelSelector(
      [{
        provider: "qwen",
        model: "safe\u001B[31m\u202Ehidden",
        apiKeyConfigured: true,
      }],
      0,
      false,
    ).join("\n");

    assert.doesNotMatch(rendered, /\u001B/u);
    assert.doesNotMatch(rendered, /\u202E/u);
    assert.ok(rendered.includes("\\u{001b}"));
    assert.ok(rendered.includes("\\u{202e}"));
  });

  it("uses arrow keys to switch models and restores raw mode and the cursor", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const selection = selectStartupModel(STARTUP_CHOICES, {
      input,
      output,
      initialProvider: "qwen",
      color: false,
    });

    input.write("\u001B[B\r");

    assert.equal(await selection, "deepseek");
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.match(transcript(), /\u001B\[\?25l/u);
    assert.match(transcript(), /\u001B\[\?25h/u);
  });

  it("cancels on Ctrl+C and still restores terminal state", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const selection = selectStartupModel(STARTUP_CHOICES, {
      input,
      output,
      initialProvider: "qwen",
      color: false,
    });

    input.write("\u0003");

    assert.equal(await selection, undefined);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
  });

  it("prompts for and verifies a missing selected API key before switching", async () => {
    const secret = "deepseek-startup-secret";
    const terminal = new ScriptedStartupTerminal("deepseek", secret);
    const store = new MemoryCredentialStore();

    await withStartupApp(terminal, store, async (app) => {
      await app.runInteractive();
      await app.handleSlashCommand("/model");
    });

    assert.equal(terminal.initialProvider, "qwen");
    assert.deepEqual(
      terminal.choices.map(({ provider, apiKeyConfigured }) => ({ provider, apiKeyConfigured })),
      [
        { provider: "qwen", apiKeyConfigured: false },
        { provider: "deepseek", apiKeyConfigured: false },
      ],
    );
    assert.equal(store.values.get("deepseek"), secret);
    assert.deepEqual(store.writes, ["deepseek"]);
    assert.equal(terminal.secretPrompts.length, 1);
    assert.match(terminal.secretPrompts[0] ?? "", /Enter the DeepSeek API key/u);
    assert.match(terminal.transcript, /Saved deepseek\.api-key/u);
    assert.match(terminal.transcript, /Selected DeepSeek \/ deepseek-test-model/u);
    assert.match(terminal.transcript, /"provider": "deepseek"/u);
    assert.doesNotMatch(terminal.transcript, new RegExp(secret, "u"));
  });

  it("does not request or rewrite an API key that is already configured", async () => {
    const terminal = new ScriptedStartupTerminal("qwen", "unused-secret");
    const store = new MemoryCredentialStore();
    store.values.set("qwen", "configured-qwen-key");

    await withStartupApp(terminal, store, async (app) => {
      await app.runInteractive();
    });

    assert.equal(terminal.choices[0]?.apiKeyConfigured, true);
    assert.deepEqual(terminal.secretPrompts, []);
    assert.deepEqual(store.writes, []);
    assert.match(terminal.transcript, /Selected Qwen \/ qwen-test-model/u);
    assert.doesNotMatch(terminal.transcript, /configured-qwen-key/u);
  });
});
