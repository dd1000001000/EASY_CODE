import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultEasyCodeConfig } from "../src/config/index.js";
import {
  PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
  EASY_CODE_RUNTIME_VERSION,
} from "../src/prompt-bundle/generated.js";
import {
  activePromptBundleBinding,
  ensurePromptBundleForTesting,
  loadPromptBundleCatalog,
} from "../src/prompt-bundle/manager.js";
import {
  computeToolSchemaHash,
  parsePromptBundleManifest,
} from "../src/prompt-bundle/manifest.js";
import { getEasyCodeHome } from "../src/prompt-bundle/paths.js";
import { createSessionState } from "../src/runtime/state.js";
import {
  deserializeSessionState,
  serializeSessionState,
} from "../src/threads/serialization.js";
import { describe, it } from "./harness.js";

const packagedBundleDirectory = path.join(process.cwd(), "resources", "prompt-bundle");

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "easy-code-prompt-bundle-"));
}

function fixtureOptions(homeDirectory: string, source = packagedBundleDirectory) {
  return {
    homeDirectory,
    packagedBundleDirectory: source,
    expectedManifestHash: PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
    runtimeVersion: EASY_CODE_RUNTIME_VERSION,
  };
}

describe("Prompt Bundle infrastructure", () => {
  it("uses only the fixed home directory and ignores path-like environment variables", () => {
    const previous = process.env.EASY_CODE_HOME;
    process.env.EASY_CODE_HOME = path.join(os.tmpdir(), "must-not-be-used");
    try {
      assert.equal(getEasyCodeHome(), path.join(os.homedir(), ".easy_code"));
    } finally {
      if (previous === undefined) delete process.env.EASY_CODE_HOME;
      else process.env.EASY_CODE_HOME = previous;
    }
  });

  it("installs, activates and synchronously exposes an immutable verified Catalog", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, ".easy_code");
    try {
      const catalog = await ensurePromptBundleForTesting(fixtureOptions(home));
      assert.equal(loadPromptBundleCatalog(), catalog);
      assert.match(catalog.readText("system/base.md"), /EASY CODE/u);
      assert.equal(catalog.getTool("run_command").contractVersion, "1.0.0");
      assert.deepEqual(catalog.listTools().includes("read_file"), true);
      const binding = activePromptBundleBinding();
      assert.equal(binding.bundleVersion, catalog.manifest.bundleVersion);
      assert.equal(binding.manifestHash, catalog.manifestHash);
      assert.match(binding.toolCatalogHash, /^sha256:[a-f0-9]{64}$/u);
      const rendered = catalog.render("runtime/context-pressure-suggest.md", { percent: 60 });
      assert.match(rendered, /60%/u);
      assert.throws(
        () => catalog.render("runtime/context-pressure-suggest.md", {}),
        /missing percent/u,
      );
      assert.throws(
        () => catalog.render("runtime/context-pressure-suggest.md", { percent: 60, extra: true }),
        /unknown extra/u,
      );

      const active = JSON.parse(await readFile(path.join(home, "active.json"), "utf8")) as {
        directory: string;
        manifestHash: string;
      };
      assert.equal(active.directory, `prompt-${catalog.manifest.bundleVersion}`);
      assert.equal(active.manifestHash, PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs modified and unlisted installed resources from the packaged Bundle", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, ".easy_code");
    try {
      const first = await ensurePromptBundleForTesting(fixtureOptions(home));
      const destination = path.join(home, "bundles", `prompt-${first.manifest.bundleVersion}`);
      await writeFile(path.join(destination, "system", "base.md"), "tampered", "utf8");
      await writeFile(path.join(destination, "unlisted.md"), "untrusted", "utf8");

      const repaired = await ensurePromptBundleForTesting(fixtureOptions(home));
      assert.match(repaired.readText("system/base.md"), /EASY CODE/u);
      await assert.rejects(readFile(path.join(destination, "unlisted.md")), /ENOENT/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a modified packaged Bundle instead of installing untrusted text", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "package-resources");
    const home = path.join(root, ".easy_code");
    try {
      await cp(packagedBundleDirectory, source, { recursive: true });
      await writeFile(path.join(source, "system", "base.md"), "modified package", "utf8");
      await assert.rejects(
        ensurePromptBundleForTesting(fixtureOptions(home, source)),
        /file (?:metadata|hash) mismatch/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent ensure calls through the private installation lock", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, ".easy_code");
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => ensurePromptBundleForTesting(fixtureOptions(home))),
      );
      assert.equal(new Set(results.map((item) => item.manifestHash)).size, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and computes stable schema hashes independently of key order", () => {
    assert.throws(
      () => parsePromptBundleManifest({
        formatVersion: 1,
        bundleVersion: "1.0.0",
        runtimeCompatibility: { min: "0.1.0", maxExclusive: "0.2.0" },
        files: { "../escape.md": { sha256: `sha256:${"0".repeat(64)}`, bytes: 0 } },
        tools: {},
        bundleHash: `sha256:${"0".repeat(64)}`,
      }),
      /escapes|normalized/u,
    );
    assert.equal(
      computeToolSchemaHash({ type: "object", properties: { b: 2, a: 1 } }),
      computeToolSchemaHash({ properties: { a: 1, b: 2 }, type: "object" }),
    );
  });

  it("persists the exact Bundle identity while accepting legacy sessions", () => {
    const binding = activePromptBundleBinding();
    const state = createSessionState(
      createDefaultEasyCodeConfig(process.cwd(), {
        dataDir: path.join(process.cwd(), ".data"),
        configDir: path.join(process.cwd(), ".config"),
        cacheDir: path.join(process.cwd(), ".cache"),
      }),
      "thread_prompt_binding",
      binding,
    );
    const serialized = serializeSessionState(state);
    assert.deepEqual(deserializeSessionState(serialized).promptBundle, binding);

    const legacy = { ...serialized } as Record<string, unknown>;
    delete legacy.promptBundle;
    assert.equal(deserializeSessionState(legacy).promptBundle, undefined);
    assert.throws(
      () => deserializeSessionState({
        ...serialized,
        promptBundle: { ...binding, manifestHash: "sha256:not-a-hash" },
      }),
      /Invalid serialized session state/u,
    );
  });
});
