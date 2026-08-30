import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { Command } from "commander";

import {
  SystemKeyringCredentialStore,
  loadEasyCodeConfig,
  parseApiKeyConfigKey,
  readSecretInput,
  registerConfigCommands,
  type ApiKeyCredentialStore,
  type ConfigCommandRuntime,
} from "../src/config/index.js";
import type { ProviderName } from "../src/core/types.js";
import { describe, it } from "./harness.js";

class MemoryCredentialStore implements ApiKeyCredentialStore {
  readonly values = new Map<ProviderName, string>();
  failReads = false;
  failDeletes = false;

  async get(provider: ProviderName): Promise<string | undefined> {
    if (this.failReads) throw new Error("simulated native keyring error");
    return this.values.get(provider);
  }

  async set(provider: ProviderName, value: string): Promise<void> {
    this.values.set(provider, value);
  }

  async delete(provider: ProviderName): Promise<boolean> {
    if (this.failDeletes) return false;
    return this.values.delete(provider);
  }
}

class StringOutput {
  value = "";

  write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

function commandRun(
  arguments_: string[],
  runtime: ConfigCommandRuntime,
): { run: Promise<void>; output: StringOutput; errorOutput: StringOutput } {
  const output = new StringOutput();
  const errorOutput = new StringOutput();
  const program = new Command()
    .name("easy-code")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => output.write(value),
      writeErr: (value) => errorOutput.write(value),
    });
  registerConfigCommands(program, { ...runtime, output, errorOutput });
  return {
    run: program.parseAsync(["node", "easy-code", ...arguments_]).then(() => undefined),
    output,
    errorOutput,
  };
}

describe("config commands", () => {
  it("accepts only the three exact provider API-key keys", () => {
    assert.deepEqual(parseApiKeyConfigKey("qwen.api-key"), {
      key: "qwen.api-key",
      provider: "qwen",
    });
    assert.deepEqual(parseApiKeyConfigKey("glm.api-key"), {
      key: "glm.api-key",
      provider: "glm",
    });
    assert.throws(() => parseApiKeyConfigKey("qwen.api_key"), /Valid keys/u);
    assert.throws(() => parseApiKeyConfigKey("deepseek.apiKey"), /Valid keys/u);
    assert.throws(() => parseApiKeyConfigKey("qwen.model"), /Valid keys/u);
    assert.throws(() => parseApiKeyConfigKey("workspace.qwen.api-key"), /Valid keys/u);
  });

  it("reads standard input, verifies the write, and never prints the secret", async () => {
    const store = new MemoryCredentialStore();
    const secret = "explicit-super-secret";
    const command = commandRun(
      ["config", "set", "qwen.api-key"],
      {
        credentialStore: store,
        env: {},
        input: Readable.from([`${secret}\n`]),
      },
    );
    await command.run;

    assert.equal(store.values.get("qwen"), secret);
    assert.match(command.output.value, /Stored qwen\.api-key/u);
    assert.doesNotMatch(command.output.value + command.errorOutput.value, new RegExp(secret, "u"));
  });

  it("rejects a positional API key instead of silently ignoring it", async () => {
    const store = new MemoryCredentialStore();
    const secret = "must-not-be-accepted-from-argv";
    const command = commandRun(
      ["config", "set", "qwen.api-key", secret],
      {
        credentialStore: store,
        env: {},
        input: Readable.from(["unused-standard-input\n"]),
      },
    );

    await assert.rejects(command.run, /too many arguments/u);
    assert.equal(store.values.size, 0);
    assert.doesNotMatch(
      command.output.value + command.errorOutput.value,
      new RegExp(secret, "u"),
    );
  });

  it("reads an omitted value from standard input without echoing it", async () => {
    const store = new MemoryCredentialStore();
    const secret = "piped-super-secret";
    const command = commandRun(
      ["config", "set", "deepseek.api-key"],
      {
        credentialStore: store,
        env: {},
        input: Readable.from([`${secret}\n`]),
      },
    );
    await command.run;

    assert.equal(store.values.get("deepseek"), secret);
    assert.doesNotMatch(command.output.value + command.errorOutput.value, new RegExp(secret, "u"));
  });

  it("stores a GLM key under the dedicated keyring entry", async () => {
    const store = new MemoryCredentialStore();
    const secret = "glm-super-secret";
    const command = commandRun(["config", "set", "glm.api-key"], {
      credentialStore: store,
      env: {},
      input: Readable.from([`${secret}\n`]),
    });
    await command.run;

    assert.equal(store.values.get("glm"), secret);
    assert.match(command.output.value, /Stored glm\.api-key/u);
    assert.doesNotMatch(
      command.output.value + command.errorOutput.value,
      new RegExp(secret, "u"),
    );
  });

  it("fails a set whose operating-system read-back cannot be verified", async () => {
    const store = new MemoryCredentialStore();
    store.failReads = true;
    const command = commandRun(
      ["config", "set", "qwen.api-key"],
      {
        credentialStore: store,
        env: {},
        input: Readable.from(["never-output-this\n"]),
      },
    );
    await assert.rejects(command.run, /did not verify/u);
    assert.doesNotMatch(
      command.output.value + command.errorOutput.value,
      /never-output-this/u,
    );
    assert.doesNotMatch(command.output.value, /Stored/u);
  });

  it("handles UTF-8 and terminal editing without leaking escape sequences", async () => {
    class TestTerminal extends PassThrough {
      readonly isTTY = true;
      isRaw = false;
      readonly transitions: boolean[] = [];

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.transitions.push(mode);
        return this;
      }
    }

    const terminal = new TestTerminal();
    const output = new StringOutput();
    const result = readSecretInput(terminal, output, "API key: ");
    const unicode = Buffer.from("密", "utf8");
    terminal.write(unicode.subarray(0, 1));
    terminal.write(unicode.subarray(1));
    terminal.write("abc\u001b[Dd\bZ\r");
    assert.equal(await result, "密abcZ");
    assert.deepEqual(terminal.transitions, [true, false]);
    assert.equal(output.value, "API key: \n");
  });

  it("rejects a terminal disconnect and restores raw mode", async () => {
    class ClosingTerminal extends PassThrough {
      readonly isTTY = true;
      isRaw = false;
      readonly transitions: boolean[] = [];

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.transitions.push(mode);
        return this;
      }
    }

    const terminal = new ClosingTerminal();
    const result = readSecretInput(terminal, new StringOutput(), "API key: ");
    terminal.end();
    await assert.rejects(result, /ended before/u);
    assert.deepEqual(terminal.transitions, [true, false]);
  });

  it("reports effective source precedence without revealing any key", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-config-command-"));
    const configDir = path.join(temporary, "config");
    const userConfigPath = path.join(configDir, "config.toml");
    const store = new MemoryCredentialStore();
    const secrets = ["environment-secret", "keyring-secret", "legacy-secret"];
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        userConfigPath,
        `[qwen]\napi_key = "${secrets[2]}"\n`,
        "utf8",
      );
      store.values.set("qwen", "shadowed-keyring-secret");
      store.values.set("deepseek", secrets[1] as string);

      const listed = commandRun(["config", "list"], {
        credentialStore: store,
        env: { QWEN_API_KEY: secrets[0], ZAI_API_KEY: "glm-environment-secret" },
        userConfigPath,
      });
      await listed.run;
      assert.match(listed.output.value, /qwen\.api-key=\[configured\] \(environment variable QWEN_API_KEY\)/u);
      assert.match(listed.output.value, /deepseek\.api-key=\[configured\] \(operating system credential store\)/u);
      assert.match(listed.output.value, /glm\.api-key=\[configured\] \(environment variable ZAI_API_KEY\)/u);

      store.values.delete("qwen");
      const legacy = commandRun(["config", "get", "qwen.api-key"], {
        credentialStore: store,
        env: {},
        userConfigPath,
      });
      await legacy.run;
      assert.match(legacy.output.value, /\(legacy user config\)/u);

      const transcript = listed.output.value + listed.errorOutput.value + legacy.output.value;
      for (const secret of secrets) assert.doesNotMatch(transcript, new RegExp(secret, "u"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("keeps an absent or unreadable credential status deliberately ambiguous", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-config-unknown-"));
    try {
      const store = new MemoryCredentialStore();
      store.failReads = true;
      const command = commandRun(["config", "get", "qwen.api-key"], {
        credentialStore: store,
        env: {},
        configDir: temporary,
      });
      await command.run;
      assert.match(command.output.value, /\[unavailable or not configured\]/u);
      assert.doesNotMatch(command.output.value, /\[not set\]/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("unsets only the keyring value and reports other effective sources", async () => {
    const store = new MemoryCredentialStore();
    store.values.set("qwen", "keyring-secret");
    const command = commandRun(["config", "unset", "qwen.api-key"], {
      credentialStore: store,
      env: { QWEN_API_KEY: "environment-secret" },
    });
    await command.run;
    assert.equal(store.values.has("qwen"), false);
    assert.match(command.output.value, /Deleted qwen\.api-key/u);
    assert.match(command.errorOutput.value, /remains configured.*QWEN_API_KEY/u);
    assert.doesNotMatch(command.output.value + command.errorOutput.value, /environment-secret|keyring-secret/u);
  });

  it("fails unset when native deletion is absent or cannot be verified", async () => {
    const store = new MemoryCredentialStore();
    store.failDeletes = true;
    const command = commandRun(["config", "unset", "qwen.api-key"], {
      credentialStore: store,
      env: {},
    });
    await assert.rejects(command.run, /not deleted or deletion could not be verified/u);
    assert.doesNotMatch(command.output.value, /Deleted/u);
  });
});

describe("credential configuration loading", () => {
  it("loads environment over keyring over legacy user TOML", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-key-precedence-"));
    const configDir = path.join(temporary, "config");
    const store = new MemoryCredentialStore();
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, "config.toml"),
        `[qwen]\napi_key = "legacy-qwen"\n[deepseek]\napi_key = "legacy-deepseek"\n[glm]\napi_key = "legacy-glm"\n`,
        "utf8",
      );
      store.values.set("qwen", "keyring-qwen");
      store.values.set("deepseek", "keyring-deepseek");
      store.values.set("glm", "keyring-glm");

      const withEnvironment = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          QWEN_API_KEY: "environment-qwen",
          ZAI_API_KEY: "environment-glm",
        },
        credentialStore: store,
      });
      assert.equal(withEnvironment.qwen.apiKey, "environment-qwen");
      assert.equal(withEnvironment.deepseek.apiKey, "keyring-deepseek");
      assert.equal(withEnvironment.glm.apiKey, "environment-glm");

      const withoutEnvironment = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {},
        credentialStore: store,
      });
      assert.equal(withoutEnvironment.qwen.apiKey, "keyring-qwen");
      assert.equal(withoutEnvironment.deepseek.apiKey, "keyring-deepseek");
      assert.equal(withoutEnvironment.glm.apiKey, "keyring-glm");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("round-trips an isolated Windows credential with Node 20.11.0 when requested", async () => {
    if (
      process.platform !== "win32" ||
      process.env.EASY_CODE_RUN_KEYRING_INTEGRATION !== "1"
    ) {
      return;
    }
    assert.equal(process.versions.node, "20.11.0");

    const service = `easy-code-agent-test-${process.pid}-${randomUUID()}`;
    const secret = `easy-code-test-${randomUUID()}`;
    const store = new SystemKeyringCredentialStore(service);
    try {
      await store.set("qwen", secret);
      assert.equal(await store.get("qwen"), secret);
      assert.equal(await store.delete("qwen"), true);
      assert.equal(await store.get("qwen"), undefined);
    } finally {
      await store.delete("qwen").catch(() => false);
    }
  });
});
