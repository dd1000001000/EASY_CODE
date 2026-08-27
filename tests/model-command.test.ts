import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
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

interface AppFixture {
  app: EasyCodeApp;
  output(): string;
  close(): void;
}

async function createAppFixture(keys: {
  qwen?: string;
  deepseek?: string;
}): Promise<AppFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-model-command-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const previous = new Map(
    TEST_ENVIRONMENT.map((name) => [name, process.env[name]] as const),
  );
  process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
  process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
  process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
  process.env.EASY_CODE_PROVIDER = "qwen";
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  if (keys.qwen) process.env.QWEN_API_KEY = keys.qwen;
  else delete process.env.QWEN_API_KEY;
  if (keys.deepseek) process.env.DEEPSEEK_API_KEY = keys.deepseek;
  else delete process.env.DEEPSEEK_API_KEY;

  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let transcript = "";
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  const terminal = new Terminal(input, output);

  try {
    const app = await EasyCodeApp.create({
      workspaceRoot: workspace,
      terminal,
      // Never inspect the developer's real operating-system credentials.
      credentialStore: false,
    });
    let closed = false;
    return {
      app,
      output: () => transcript,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          app.close();
        } finally {
          terminal.close();
          restoreEnvironment(previous);
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    terminal.close();
    restoreEnvironment(previous);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restoreEnvironment(
  previous: ReadonlyMap<string, string | undefined>,
): void {
  for (const name of TEST_ENVIRONMENT) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function assertMissingKey(
  provider: "qwen" | "deepseek",
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      new RegExp(`easy-code config set ${provider}\\.api-key`, "u"),
    );
    assert.doesNotMatch(error.message, /config\.toml|YOUR_API_KEY/u);
    return true;
  };
}

describe("/model", () => {
  it("shows both key states and atomically rejects an unconfigured provider", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      let offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model");
      const initial = fixture.output().slice(offset);
      assert.match(initial, /"provider": "qwen"/u);
      assert.match(initial, /"keyConfigured": \{/u);
      assert.match(initial, /"qwen": true/u);
      assert.match(initial, /"deepseek": false/u);

      await assert.rejects(
        fixture.app.handleSlashCommand("/model deepseek deepseek-test"),
        assertMissingKey("deepseek"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/provider deepseek"),
        assertMissingKey("deepseek"),
      );

      offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model");
      const unchanged = fixture.output().slice(offset);
      assert.match(unchanged, /"provider": "qwen"/u);
      assert.doesNotMatch(unchanged, /deepseek-test/u);

      offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model qwen-next");
      await fixture.app.handleSlashCommand("/model");
      const currentProviderModel = fixture.output().slice(offset);
      assert.match(currentProviderModel, /qwen\/qwen-next/u);
      assert.match(currentProviderModel, /"model": "qwen-next"/u);

      await assert.rejects(
        fixture.app.handleSlashCommand("/model qwen"),
        /Usage: \/model/u,
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model unknown model"),
        /Usage: \/model/u,
      );
    } finally {
      fixture.close();
    }
  });

  it("switches provider/model when the target key is configured", async () => {
    const fixture = await createAppFixture({
      qwen: "qwen-test-key",
      deepseek: "deepseek-test-key",
    });
    try {
      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model deepseek deepseek-test");
      await fixture.app.handleSlashCommand("/model");
      const result = fixture.output().slice(offset);
      assert.match(result, /deepseek\/deepseek-test/u);
      assert.match(result, /"provider": "deepseek"/u);
      assert.match(result, /"model": "deepseek-test"/u);
      assert.match(result, /"qwen": true/u);
      assert.match(result, /"deepseek": true/u);
    } finally {
      fixture.close();
    }
  });

  it("fails the first task locally when the active provider has no key", async () => {
    const fixture = await createAppFixture({});
    try {
      await assert.rejects(
        fixture.app.runOnce("do not send a network request"),
        assertMissingKey("qwen"),
      );
    } finally {
      fixture.close();
    }
  });
});
