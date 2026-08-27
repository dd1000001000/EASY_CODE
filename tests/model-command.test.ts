import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import type {
  ModelSelectorChoice,
  ProviderSelectorChoice,
} from "../src/cli/model-selector.js";
import { Terminal } from "../src/cli/terminal.js";
import type { ProviderName } from "../src/core/types.js";
import { createStorage } from "../src/storage/index.js";
import { ThreadStore } from "../src/threads/index.js";
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
  terminal: Terminal;
  workspace: string;
  dataDir: string;
  output(): string;
  close(): void;
}

class ScriptedModelTerminal extends Terminal {
  providerChoices: readonly ProviderSelectorChoice[] = [];
  modelChoices: readonly ModelSelectorChoice[] = [];

  constructor(
    input: PassThrough,
    output: PassThrough,
    private readonly providerSelection: ProviderName | undefined,
    private readonly modelSelection: string | undefined,
  ) {
    super(input, output);
  }

  override isInteractive(): boolean {
    return true;
  }

  override async selectProvider(
    choices: readonly ProviderSelectorChoice[],
  ): Promise<ProviderName | undefined> {
    this.providerChoices = choices;
    return this.providerSelection;
  }

  override async selectModel(
    _providerName: string,
    choices: readonly ModelSelectorChoice[],
  ): Promise<string | undefined> {
    this.modelChoices = choices;
    return this.modelSelection;
  }
}

async function createAppFixture(
  keys: { qwen?: string; deepseek?: string },
  selection?: { provider?: ProviderName; model?: string },
): Promise<AppFixture> {
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
  const terminal = selection
    ? new ScriptedModelTerminal(
        input,
        output,
        selection.provider,
        selection.model,
      )
    : new Terminal(input, output);

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
      terminal,
      workspace,
      dataDir: path.join(root, "data"),
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
  it("validates direct switches against the provider catalog and preserves state on failure", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      await assert.rejects(
        fixture.app.handleSlashCommand("/model deepseek deepseek-v4-pro"),
        assertMissingKey("deepseek"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/provider deepseek"),
        assertMissingKey("deepseek"),
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model qwen deepseek-v4-pro"),
        /not in the Alibaba Qwen catalog/u,
      );
      await assert.rejects(
        fixture.app.handleSlashCommand("/model unknown-model"),
        /Supported models:/u,
      );

      let offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/status");
      const unchanged = fixture.output().slice(offset);
      assert.match(unchanged, /"provider": "qwen"/u);
      assert.match(unchanged, /"model": "qwen3\.7-max"/u);

      offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model Qwen3.7-Plus");
      await fixture.app.handleSlashCommand("/status");
      const switched = fixture.output().slice(offset);
      assert.match(switched, /Alibaba Qwen \/ qwen3\.7-plus/u);
      assert.match(switched, /"model": "qwen3\.7-plus"/u);

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

  it("switches provider/model directly when the target key is configured", async () => {
    const fixture = await createAppFixture({
      qwen: "qwen-test-key",
      deepseek: "deepseek-test-key",
    });
    try {
      const offset = fixture.output().length;
      await fixture.app.handleSlashCommand("/model deepseek deepseek-v4-flash");
      await fixture.app.handleSlashCommand("/status");
      const result = fixture.output().slice(offset);
      assert.match(result, /DeepSeek \/ deepseek-v4-flash/u);
      assert.match(result, /"provider": "deepseek"/u);
      assert.match(result, /"model": "deepseek-v4-flash"/u);
    } finally {
      fixture.close();
    }
  });

  it("opens the provider menu first and then the selected provider's model menu", async () => {
    const fixture = await createAppFixture(
      { qwen: "qwen-test-key", deepseek: "deepseek-test-key" },
      { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    );
    try {
      await fixture.app.handleSlashCommand("/model");
      await fixture.app.handleSlashCommand("/status");

      const terminal = fixture.terminal as ScriptedModelTerminal;
      assert.deepEqual(
        terminal.providerChoices.map((choice) => choice.label),
        ["DeepSeek", "Alibaba Qwen"],
      );
      assert.deepEqual(
        terminal.modelChoices.map((choice) => choice.id),
        [
          "deepseek-v4-flash",
          "deepseek-v4-pro",
          "deepseek-v4-flash-vision-exp",
        ],
      );
      assert.match(fixture.output(), /DeepSeek \/ deepseek-v4-flash-vision-exp/u);
      assert.match(fixture.output(), /"provider": "deepseek"/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps the current selection when the model stage is canceled", async () => {
    const fixture = await createAppFixture(
      { qwen: "qwen-test-key", deepseek: "deepseek-test-key" },
      { provider: "deepseek" },
    );
    try {
      await fixture.app.handleSlashCommand("/model");
      await fixture.app.handleSlashCommand("/status");
      assert.match(fixture.output(), /Model selection canceled/u);
      assert.match(fixture.output(), /"provider": "qwen"/u);
      assert.match(fixture.output(), /"model": "qwen3\.7-max"/u);
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

  it("queues /image paths only for verified vision models", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR4nGNgGAWjYBSMAggAAAQQAAFVN1rQAAAAAElFTkSuQmCC",
        "base64",
      );
      writeFileSync(path.join(fixture.workspace, "screen shot.png"), png);
      await assert.rejects(
        fixture.app.handleSlashCommand('/image "screen shot.png"'),
        /text-only/u,
      );

      await fixture.app.handleSlashCommand("/model qwen3-vl-plus");
      await fixture.app.handleSlashCommand('/image "screen shot.png"');
      await fixture.app.handleSlashCommand("/status");
      assert.match(fixture.output(), /Queued Image #1: 16x16 image\/png/u);
      assert.match(fixture.output(), /"pendingImages": \[\s*"Image #1"/u);
      assert.match(fixture.output(), /"vision": true/u);

      await fixture.app.handleSlashCommand("/model qwen3-max");
      assert.match(fixture.output(), /queued image\(s\) remain attached/u);
    } finally {
      fixture.close();
    }
  });
});

describe("thread leases", () => {
  it("transfers ownership for /new and /resume and releases it on close", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    const activeThread = (): string =>
      (fixture.app as unknown as { state: { threadId: string } }).state.threadId;
    try {
      const firstThreadId = activeThread();
      await fixture.app.handleSlashCommand("/new");
      const secondThreadId = activeThread();
      assert.notEqual(secondThreadId, firstThreadId);

      const probeStorage = createStorage(fixture.dataDir);
      try {
        const probeThreads = new ThreadStore(probeStorage);
        const releasedFirst = probeThreads.acquireThreadLease(firstThreadId);
        probeThreads.releaseThreadLease(releasedFirst);
        assert.throws(
          () => probeThreads.acquireThreadLease(secondThreadId),
          /already active/u,
        );
      } finally {
        probeStorage.close();
      }

      await fixture.app.handleSlashCommand(`/resume ${firstThreadId}`);
      assert.equal(activeThread(), firstThreadId);
      const transferredStorage = createStorage(fixture.dataDir);
      try {
        const transferredThreads = new ThreadStore(transferredStorage);
        const releasedSecond = transferredThreads.acquireThreadLease(secondThreadId);
        transferredThreads.releaseThreadLease(releasedSecond);
        assert.throws(
          () => transferredThreads.acquireThreadLease(firstThreadId),
          /already active/u,
        );
      } finally {
        transferredStorage.close();
      }

      fixture.app.close();
      const closedStorage = createStorage(fixture.dataDir);
      try {
        const closedThreads = new ThreadStore(closedStorage);
        const releasedOnClose = closedThreads.acquireThreadLease(firstThreadId);
        closedThreads.releaseThreadLease(releasedOnClose);
      } finally {
        closedStorage.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("acquires before interrupted-turn repair and releases after create failure", async () => {
    const fixture = await createAppFixture({ qwen: "configured-for-test" });
    const setupStorage = createStorage(fixture.dataDir);
    try {
      const threads = new ThreadStore(setupStorage);
      const canonicalWorkspace = (
        fixture.app as unknown as { workspace: { root: string } }
      ).workspace.root;
      const target = threads.create({
        threadId: "thread_app_lease_target",
        workspaceRoot: canonicalWorkspace,
        mode: "auto",
        provider: "qwen",
        model: "qwen3-vl-plus",
      });
      threads.startTurn(target.threadId, "unfinished request", "turn_unfinished");
      const blocker = threads.acquireThreadLease(target.threadId);

      await assert.rejects(
        EasyCodeApp.create({
          workspaceRoot: fixture.workspace,
          resumeThreadId: target.threadId,
          terminal: new Terminal(new PassThrough(), new PassThrough()),
          credentialStore: false,
        }),
        /already active/u,
      );
      assert.equal(threads.recover(target.threadId).activeTurnId, "turn_unfinished");
      threads.releaseThreadLease(blocker);

      await assert.rejects(
        EasyCodeApp.create({
          workspaceRoot: fixture.workspace,
          resumeThreadId: target.threadId,
          imagePaths: [path.join(fixture.workspace, "missing-image.png")],
          terminal: new Terminal(new PassThrough(), new PassThrough()),
          credentialStore: false,
        }),
        /does not exist|not found|no such file/iu,
      );
      const releasedAfterFailure = threads.acquireThreadLease(target.threadId);
      threads.releaseThreadLease(releasedAfterFailure);
    } finally {
      setupStorage.close();
      fixture.close();
    }
  });
});
