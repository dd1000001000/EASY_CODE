import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import {
  renderModelSelector,
  renderProviderSelector,
  selectModel,
  selectProvider,
  type ModelSelectorChoice,
  type ProviderSelectorChoice,
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

const PROVIDER_CHOICES: readonly ProviderSelectorChoice[] = [
  { provider: "deepseek", label: "DeepSeek", apiKeyConfigured: false },
  { provider: "qwen", label: "Alibaba Qwen", apiKeyConfigured: true },
];

const QWEN_CHOICES: readonly ModelSelectorChoice[] = [
  { id: "qwen3.7-max", label: "Qwen3.7-Max" },
  { id: "qwen3.7-plus", label: "Qwen3.7-Plus" },
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
  providerChoices: readonly ProviderSelectorChoice[] = [];
  modelChoices: readonly ModelSelectorChoice[] = [];
  initialProvider?: ProviderName;
  initialModel?: string;
  selectedProviderLabel?: string;
  readonly secretPrompts: string[] = [];

  constructor(
    private readonly providerSelection: ProviderName | undefined,
    private readonly modelSelection: string | undefined,
    private readonly secret: string,
  ) {
    super(new PassThrough(), new PassThrough());
  }

  override isInteractive(): boolean {
    return true;
  }

  override async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderName,
  ): Promise<ProviderName | undefined> {
    this.providerChoices = choices;
    this.initialProvider = initialProvider;
    return this.providerSelection;
  }

  override async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    this.selectedProviderLabel = providerName;
    this.modelChoices = choices;
    this.initialModel = initialModel;
    return this.modelSelection;
  }

  override async readSecret(prompt: string): Promise<string> {
    this.secretPrompts.push(prompt);
    return this.secret;
  }

  override async question(): Promise<string | null> {
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
  process.env.QWEN_MODEL = "qwen3.7-plus";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
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

describe("two-stage model selector", () => {
  it("renders the selected provider in white and the other provider in gray", () => {
    const lines = renderProviderSelector(PROVIDER_CHOICES, 1, true);

    assert.match(lines[1] ?? "", /\u001B\[90m/u);
    assert.match(lines[2] ?? "", /\u001B\[37m/u);
    assert.match(lines[1] ?? "", /DeepSeek/u);
    assert.match(lines[2] ?? "", /› Alibaba Qwen/u);
  });

  it("renders model labels and neutralizes terminal controls", () => {
    const rendered = renderModelSelector(
      "Alibaba Qwen",
      [{ id: "safe-id", label: "safe\u001B[31m\u202Ehidden" }],
      0,
      false,
    ).join("\n");

    assert.match(rendered, /Select a model from Alibaba Qwen/u);
    assert.doesNotMatch(rendered, /\u001B/u);
    assert.doesNotMatch(rendered, /\u202E/u);
    assert.ok(rendered.includes("\\u{001b}"));
    assert.ok(rendered.includes("\\u{202e}"));
  });

  it("uses arrow keys for both stages and restores raw mode and the cursor", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const providerSelection = selectProvider(PROVIDER_CHOICES, {
      input,
      output,
      initialProvider: "deepseek",
      color: false,
    });
    input.write("\u001B[B\r");
    assert.equal(await providerSelection, "qwen");

    const modelSelection = selectModel("Alibaba Qwen", QWEN_CHOICES, {
      input,
      output,
      initialModel: "qwen3.7-max",
      color: false,
    });
    input.write("\u001B[B\r");
    assert.equal(await modelSelection, "qwen3.7-plus");

    assert.deepEqual(input.rawModeTransitions, [true, false, true, false]);
    assert.match(transcript(), /\u001B\[\?25l/u);
    assert.match(transcript(), /\u001B\[\?25h/u);
  });

  it("can open a raw selector after the main readline prompt has completed", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const terminal = new Terminal(input, output);

    const answer = terminal.question("EASY CODE > ");
    input.write("/model\r");
    assert.equal(await answer, "/model");

    const selection = terminal.selectProvider(PROVIDER_CHOICES, "qwen");
    input.write("\r");
    assert.equal(await selection, "qwen");

    const secret = terminal.readSecret("API key: ");
    input.write("secret-value\r");
    assert.equal(await secret, "secret-value");
    terminal.close();
  });

  it("cancels either selector on Ctrl+C and restores terminal state", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const selection = selectProvider(PROVIDER_CHOICES, {
      input,
      output,
      initialProvider: "qwen",
      color: false,
    });
    input.write("\u0003");

    assert.equal(await selection, undefined);
    assert.deepEqual(input.rawModeTransitions, [true, false]);
  });

  it("shows providers first, then only DeepSeek models, and saves a missing key", async () => {
    const secret = "deepseek-startup-secret";
    const terminal = new ScriptedStartupTerminal(
      "deepseek",
      "deepseek-v4-flash-vision-exp",
      secret,
    );
    const store = new MemoryCredentialStore();

    await withStartupApp(terminal, store, async (app) => {
      await app.runInteractive();
    });

    assert.equal(terminal.initialProvider, "qwen");
    assert.deepEqual(
      terminal.providerChoices.map(({ provider, label }) => ({ provider, label })),
      [
        { provider: "deepseek", label: "DeepSeek" },
        { provider: "qwen", label: "Alibaba Qwen" },
      ],
    );
    assert.equal(terminal.selectedProviderLabel, "DeepSeek");
    assert.equal(terminal.initialModel, "deepseek-v4-pro");
    assert.deepEqual(
      terminal.modelChoices.map((choice) => choice.id),
      [
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-v4-flash-vision-exp",
      ],
    );
    assert.equal(store.values.get("deepseek"), secret);
    assert.deepEqual(store.writes, ["deepseek"]);
    assert.equal(terminal.secretPrompts.length, 1);
    assert.match(terminal.secretPrompts[0] ?? "", /Enter the DeepSeek API key/u);
    assert.match(terminal.transcript, /Saved deepseek\.api-key/u);
    assert.match(
      terminal.transcript,
      /Selected DeepSeek \/ deepseek-v4-flash-vision-exp/u,
    );
    assert.doesNotMatch(terminal.transcript, new RegExp(secret, "u"));
  });

  it("shows all Alibaba Qwen models and does not rewrite an existing key", async () => {
    const terminal = new ScriptedStartupTerminal("qwen", "qwen3-vl-flash", "unused");
    const store = new MemoryCredentialStore();
    store.values.set("qwen", "configured-qwen-key");

    await withStartupApp(terminal, store, async (app) => {
      await app.runInteractive();
    });

    assert.equal(terminal.selectedProviderLabel, "Alibaba Qwen");
    assert.deepEqual(
      terminal.modelChoices.map((choice) => choice.id),
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
    assert.deepEqual(terminal.secretPrompts, []);
    assert.deepEqual(store.writes, []);
    assert.match(terminal.transcript, /Selected Alibaba Qwen \/ qwen3-vl-flash/u);
    assert.doesNotMatch(terminal.transcript, /configured-qwen-key/u);
  });
});
