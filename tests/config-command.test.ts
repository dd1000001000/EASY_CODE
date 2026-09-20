import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { Command } from "commander";
import { parse as parseToml } from "toml";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { normalizeCurrentTomlConfig } from "../src/config/toml-format.js";
import { PROVIDER_CATALOG } from "../src/models/catalog.js";

import {
  EASY_CODE_BENCHMARK_KEYRING_SERVICE,
  EASY_CODE_KEYRING_SERVICE,
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
  it("prints a complete parseable limits template without touching credentials", async () => {
    const command = commandRun(["config", "defaults"], {});
    await command.run;
    const parsed = normalizeCurrentTomlConfig(
      parseToml(command.output.value),
      PROVIDER_CATALOG.map(({ provider }) => provider),
      defaultRuntimeLimits(),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.limits)), defaultRuntimeLimits());
    assert.equal(parsed.orchestrationEnabled, false);
    assert.doesNotMatch(command.output.value, /apiKey|api_key/u);
  });
  it("accepts the exact API-key key for every registered provider", () => {
    assert.deepEqual(parseApiKeyConfigKey("qwen.api-key"), {
      key: "qwen.api-key",
      provider: "qwen",
    });
    assert.deepEqual(parseApiKeyConfigKey("glm.api-key"), {
      key: "glm.api-key",
      provider: "glm",
    });
    assert.deepEqual(parseApiKeyConfigKey("kimi.api-key"), {
      key: "kimi.api-key",
      provider: "kimi",
    });
    assert.deepEqual(parseApiKeyConfigKey("glm-coding-plan.api-key"), {
      key: "glm-coding-plan.api-key",
      provider: "glm-coding-plan",
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

  it("stores standard GLM and GLM Coding Plan in separate keyring entries", async () => {
    const store = new MemoryCredentialStore();
    const standardSecret = "standard-glm-super-secret";
    const codingPlanSecret = "coding-plan-super-secret";

    await commandRun(["config", "set", "glm.api-key"], {
      credentialStore: store,
      env: {},
      input: Readable.from([`${standardSecret}\n`]),
    }).run;
    const codingPlanCommand = commandRun(
      ["config", "set", "glm-coding-plan.api-key"],
      {
        credentialStore: store,
        env: {},
        input: Readable.from([`${codingPlanSecret}\n`]),
      },
    );
    await codingPlanCommand.run;

    assert.equal(store.values.get("glm"), standardSecret);
    assert.equal(store.values.get("glm-coding-plan"), codingPlanSecret);
    assert.notEqual(
      store.values.get("glm"),
      store.values.get("glm-coding-plan"),
    );
    assert.match(
      codingPlanCommand.output.value,
      /Stored glm-coding-plan\.api-key/u,
    );
    assert.doesNotMatch(
      codingPlanCommand.output.value + codingPlanCommand.errorOutput.value,
      new RegExp(codingPlanSecret, "u"),
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

  it("reports only system-store credentials without revealing any key", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-config-command-"));
    const configDir = path.join(temporary, "config");
    const userConfigPath = path.join(configDir, "config.toml");
    const store = new MemoryCredentialStore();
    const secrets = ["environment-secret", "keyring-secret", "coding-plan-environment-secret"];
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        userConfigPath,
        `[providers.qwen]\nmodel = "qwen3.7-max"\n`,
        "utf8",
      );
      store.values.set("qwen", "shadowed-keyring-secret");
      store.values.set("deepseek", secrets[1]!);

      const listed = commandRun(["config", "list"], {
        credentialStore: store,
        env: {
          QWEN_API_KEY: secrets[0],
          ZAI_API_KEY: "glm-environment-secret",
          GLM_CODING_PLAN_API_KEY: secrets[2],
        },
        userConfigPath,
      });
      await listed.run;
      assert.match(listed.output.value, /qwen\.api-key=\[configured\] \(operating system credential store\)/u);
      assert.match(listed.output.value, /deepseek\.api-key=\[configured\] \(operating system credential store\)/u);
      assert.match(listed.output.value, /kimi\.api-key=\[not configured for this endpoint\]/u);
      assert.match(listed.output.value, /glm\.api-key=\[not configured for this endpoint\]/u);
      assert.match(listed.output.value, /glm-coding-plan\.api-key=\[not configured for this endpoint\]/u);

      store.values.delete("qwen");
      const absentCredential = commandRun(["config", "get", "qwen.api-key"], {
        credentialStore: store,
        env: {},
        userConfigPath,
      });
      await absentCredential.run;
      assert.match(absentCredential.output.value, /not configured for this endpoint/u);

      const transcript = listed.output.value + listed.errorOutput.value + absentCredential.output.value;
      for (const secret of secrets) assert.doesNotMatch(transcript, new RegExp(secret, "u"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("reports an unreadable credential store distinctly", async () => {
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
      assert.match(command.output.value, /\[credential store unavailable\]/u);
      assert.doesNotMatch(command.output.value, /\[not set\]/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("unsets only the keyring value without an environment fallback", async () => {
    const store = new MemoryCredentialStore();
    store.values.set("qwen", "keyring-secret");
    const command = commandRun(["config", "unset", "qwen.api-key"], {
      credentialStore: store,
      env: { QWEN_API_KEY: "environment-secret" },
    });
    await command.run;
    assert.equal(store.values.has("qwen"), false);
    assert.match(command.output.value, /Deleted qwen\.api-key/u);
    assert.equal(command.errorOutput.value, "");
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
  it("keeps memory expiry periods in user configuration, not project overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "easy-code-memory-policy-"));
    const configDir = path.join(root, "user-config");
    try {
      await mkdir(path.join(root, ".easycode"), { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(root, ".easycode", "config.toml"),
        "[limits]\nmemory_project_expiry_days = 7\n", "utf8");
      await assert.rejects(loadEasyCodeConfig({ workspaceRoot: root, configDir,
        credentialStore: false, env: {} }), /limits\.memory_project_expiry_days/u);
      await writeFile(path.join(root, ".easycode", "config.toml"), "", "utf8");
      await writeFile(path.join(configDir, "config.toml"),
        "[limits]\nmemory_project_expiry_days = 120\nmemory_global_expiry_days = 240\n", "utf8");
      const config = await loadEasyCodeConfig({ workspaceRoot: root, configDir,
        credentialStore: false, env: {} });
      assert.equal(config.limits.memoryProjectExpiryDays, 120);
      assert.equal(config.limits.memoryGlobalExpiryDays, 240);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a user TOML API key without exposing its value", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "easy-code-no-plaintext-key-"));
    const configDir = path.join(root, "config");
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.toml"),
        `[providers.qwen]\napi_key = "private-plaintext-secret"\n`, "utf8");
      await assert.rejects(loadEasyCodeConfig({
        workspaceRoot: root, configDir, credentialStore: false, env: {},
      }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /API keys in TOML are no longer supported/u);
        assert.doesNotMatch(error.message, /private-plaintext-secret/u);
        return true;
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("loads only system credentials and ignores API-key environment variables", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "easy-code-key-precedence-"));
    const configDir = path.join(temporary, "config");
    const store = new MemoryCredentialStore();
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.toml"), `[providers.qwen]\nmodel = "qwen3.7-max"\n`, "utf8");
      store.values.set("qwen", "keyring-qwen");
      store.values.set("deepseek", "keyring-deepseek");
      store.values.set("glm", "keyring-glm");
      store.values.set("glm-coding-plan", "keyring-glm-coding-plan");

      const withEnvironment = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {
          QWEN_API_KEY: "environment-qwen",
          ZAI_API_KEY: "environment-glm",
          GLM_CODING_PLAN_API_KEY: "environment-glm-coding-plan",
        },
        credentialStore: store,
      });
      assert.equal(withEnvironment.providers.qwen!.apiKey, "keyring-qwen");
      assert.equal(withEnvironment.providers.deepseek!.apiKey, "keyring-deepseek");
      assert.equal(withEnvironment.providers.glm!.apiKey, "keyring-glm");
      assert.equal(
        withEnvironment.providers["glm-coding-plan"]!.apiKey,
        "keyring-glm-coding-plan",
      );
      assert.notEqual(
        withEnvironment.providers.glm!.apiKey,
        withEnvironment.providers["glm-coding-plan"]!.apiKey,
      );

      const withoutEnvironment = await loadEasyCodeConfig({
        workspaceRoot: temporary,
        configDir,
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
        env: {},
        credentialStore: store,
      });
      assert.equal(withoutEnvironment.providers.qwen!.apiKey, "keyring-qwen");
      assert.equal(withoutEnvironment.providers.deepseek!.apiKey, "keyring-deepseek");
      assert.equal(withoutEnvironment.providers.glm!.apiKey, "keyring-glm");
      assert.equal(
        withoutEnvironment.providers["glm-coding-plan"]!.apiKey,
        "keyring-glm-coding-plan",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("round-trips an isolated native credential on Windows, macOS, or Linux when requested", async () => {
    if (process.env.EASY_CODE_RUN_KEYRING_INTEGRATION !== "1") return;
    assert.ok(["win32", "darwin", "linux"].includes(process.platform));

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

  it("isolates Runtime and Benchmark entries and binds each key to its HTTPS endpoint", async () => {
    const entries = new Map<string, string>();
    class FakeEntry {
      constructor(private readonly service: string, private readonly account: string) {}
      async getPassword() { return entries.get(`${this.service}/${this.account}`) ?? null; }
      async setPassword(value: string) { entries.set(`${this.service}/${this.account}`, value); }
      async deleteCredential() { return entries.delete(`${this.service}/${this.account}`); }
    }
    const loader = () => ({ AsyncEntry: FakeEntry }) as never;
    const ordinary = new SystemKeyringCredentialStore(EASY_CODE_KEYRING_SERVICE, loader);
    const benchmark = new SystemKeyringCredentialStore(EASY_CODE_BENCHMARK_KEYRING_SERVICE, loader);
    const endpoint = "https://open.bigmodel.cn/api/coding/paas/v4";
    await ordinary.set("glm-coding-plan", "ordinary-key", endpoint);
    await benchmark.set("glm-coding-plan", "benchmark-key", endpoint);
    assert.equal(await ordinary.get("glm-coding-plan", endpoint), "ordinary-key");
    assert.equal(await benchmark.get("glm-coding-plan", endpoint), "benchmark-key");
    assert.equal(await benchmark.get("glm-coding-plan", "https://different.example/v1"), undefined);
    assert.equal(await ordinary.delete("glm-coding-plan"), true);
    assert.equal(await ordinary.get("glm-coding-plan", endpoint), undefined);
    assert.equal(await benchmark.get("glm-coding-plan", endpoint), "benchmark-key");
    entries.set(`${EASY_CODE_BENCHMARK_KEYRING_SERVICE}/glm-coding-plan.api-key`, "obsolete-plain-key");
    await assert.rejects(benchmark.get("glm-coding-plan", endpoint), /Unable to read/u);
    await assert.rejects(
      benchmark.set("glm-coding-plan", "x".repeat(1500), endpoint),
      /2560-byte limit/u,
    );
  });
});
