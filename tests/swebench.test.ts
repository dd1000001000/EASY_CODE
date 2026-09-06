import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SWE_BENCH_VERIFIED_50,
  benchmarkEnvironment,
  buildHarborRunArgs,
  consumeHarborGlmApiKeyFile,
  resolveHarborOuterSandbox,
  validateSweBenchRoot,
} from "../src/benchmarks/swebench.js";
import { describe, it } from "./harness.js";

const EXPECTED_INSTANCE_IDS = [
  "django__django-11790",
  "django__django-11815",
  "django__django-11848",
  "django__django-11880",
  "django__django-11885",
  "django__django-11951",
  "django__django-11964",
  "django__django-11999",
  "django__django-12039",
  "django__django-12050",
  "django__django-12143",
  "django__django-12155",
  "django__django-12193",
  "django__django-12209",
  "django__django-12262",
  "django__django-12273",
  "django__django-12276",
  "django__django-12304",
  "django__django-12308",
  "django__django-12325",
  "django__django-12406",
  "django__django-12708",
  "django__django-12713",
  "django__django-12774",
  "django__django-9296",
  "sphinx-doc__sphinx-10323",
  "sphinx-doc__sphinx-10435",
  "sphinx-doc__sphinx-10466",
  "sphinx-doc__sphinx-10673",
  "sphinx-doc__sphinx-11510",
  "sphinx-doc__sphinx-7590",
  "sphinx-doc__sphinx-7748",
  "sphinx-doc__sphinx-7757",
  "sphinx-doc__sphinx-7985",
  "sphinx-doc__sphinx-8035",
  "sphinx-doc__sphinx-8056",
  "sphinx-doc__sphinx-8265",
  "sphinx-doc__sphinx-8269",
  "sphinx-doc__sphinx-8475",
  "sphinx-doc__sphinx-8548",
  "sphinx-doc__sphinx-8551",
  "sphinx-doc__sphinx-8638",
  "sphinx-doc__sphinx-8721",
  "sphinx-doc__sphinx-9229",
  "sphinx-doc__sphinx-9230",
  "sphinx-doc__sphinx-9281",
  "sphinx-doc__sphinx-9320",
  "sphinx-doc__sphinx-9367",
  "sphinx-doc__sphinx-9461",
  "sphinx-doc__sphinx-9698",
] as const;

function valuesAfter(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) values.push(args[index + 1] ?? "");
  }
  return values;
}

describe("SWE-bench Verified integration", () => {
  it("trusts Harbor's outer sandbox only when explicitly requested inside Linux Docker", () => {
    assert.equal(
      resolveHarborOuterSandbox(
        { EASY_CODE_OUTER_SANDBOX: "harbor" },
        "linux",
        true,
      ),
      "harbor",
    );

    // The marker alone must never weaken EASY CODE's command sandbox.
    assert.equal(resolveHarborOuterSandbox({}, "linux", true), undefined);
    assert.equal(resolveHarborOuterSandbox({}, "win32", false), undefined);
  });

  it("rejects unknown, host, and non-Linux outer-sandbox claims", () => {
    assert.throws(
      () => resolveHarborOuterSandbox(
        { EASY_CODE_OUTER_SANDBOX: "docker" },
        "linux",
        true,
      ),
      /EASY_CODE_OUTER_SANDBOX|harbor/iu,
    );
    assert.throws(
      () => resolveHarborOuterSandbox(
        { EASY_CODE_OUTER_SANDBOX: "harbor" },
        "win32",
        true,
      ),
      /Linux/iu,
    );
    assert.throws(
      () => resolveHarborOuterSandbox(
        { EASY_CODE_OUTER_SANDBOX: "harbor" },
        "darwin",
        true,
      ),
      /Linux/iu,
    );
    assert.throws(
      () => resolveHarborOuterSandbox(
        { EASY_CODE_OUTER_SANDBOX: "harbor" },
        "linux",
        false,
      ),
      /container|Docker|marker/iu,
    );
  });

  it("consumes and removes Harbor's one-shot GLM credential", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-harbor-key-"));
    const secretPath = path.join(directory, "glm-api-key");
    try {
      writeFileSync(secretPath, "test-secret\n", { encoding: "utf8", mode: 0o600 });
      chmodSync(secretPath, 0o600);
      const env: NodeJS.ProcessEnv = {
        EASY_CODE_GLM_API_KEY_FILE: secretPath,
      };

      assert.equal(
        consumeHarborGlmApiKeyFile("harbor", env, secretPath),
        "test-secret",
      );
      assert.equal(env.EASY_CODE_GLM_API_KEY_FILE, undefined);
      assert.equal(existsSync(secretPath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pins the recognized, duplicate-free 50-task Verified Mini subset", () => {
    assert.equal(
      SWE_BENCH_VERIFIED_50.harborDataset,
      "swe-bench/swe-bench-verified",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.harborDatasetRef,
      "sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.officialDataset,
      "SWE-bench/SWE-bench_Verified",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.officialDatasetRevision,
      "78f471bf655a3137b2e8a75af1501690ec009ec3",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.subsetSource,
      "MariusHobbhahn/swe-bench-verified-mini",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.subsetRevision,
      "b316c349947c29963fce3f4a65967c9807a4b673",
    );
    assert.equal(
      SWE_BENCH_VERIFIED_50.subsetParquetSha256,
      "f9ba19dea78884f1081355d2d8afb671899981f24180aa0c4c1aa14d2c23e855",
    );
    assert.equal(SWE_BENCH_VERIFIED_50.harnessVersion, "5.0.2");
    assert.equal(
      SWE_BENCH_VERIFIED_50.taskRepoRevision,
      "3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d",
    );
    assert.deepEqual(SWE_BENCH_VERIFIED_50.instanceIds, EXPECTED_INSTANCE_IDS);
    assert.equal(SWE_BENCH_VERIFIED_50.instanceIds.length, 50);
    assert.equal(new Set(SWE_BENCH_VERIFIED_50.instanceIds).size, 50);
  });

  it("builds one reproducible Harbor include filter per selected task", () => {
    const root = path.resolve("F:\\easy-code-bench\\swe-bench-verified-50");
    const args = buildHarborRunArgs({
      root,
      runId: "verified-50-glm-5.3-flash",
      concurrency: 4,
    });

    assert.deepEqual(args.slice(0, 21), [
      "run",
      "--dataset",
      "swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341",
      "--agent",
      "benchmarks.swebench_verified.easy_code_agent:EasyCodeAgent",
      "--model",
      "glm/glm-5.3-flash",
      "--jobs-dir",
      path.join(root, "jobs"),
      "--job-name",
      "verified-50-glm-5.3-flash",
      "--n-concurrent",
      "4",
      "--n-attempts",
      "1",
      "--agent-setup-timeout-multiplier",
      "4",
      "--yes",
      "--allow-agent-host",
      "open.bigmodel.cn",
      "--include-task-name",
    ]);
    assert.deepEqual(
      valuesAfter(args, "--include-task-name"),
      EXPECTED_INSTANCE_IDS.map((instanceId) => `swe-bench/${instanceId}`),
    );
    assert.equal(valuesAfter(args, "--dataset").length, 1);
    assert.equal(valuesAfter(args, "--agent").length, 1);
    assert.equal(valuesAfter(args, "--model").length, 1);
    assert.equal(args.includes("--provider"), false);
    assert.equal(args.includes("--thinking-effort"), false);
    assert.equal(args.includes("--mode"), false);
  });

  it("keeps the benchmark agent on the reviewed EASY CODE execution profile", () => {
    const adapterPath = fileURLToPath(new URL(
      "../../benchmarks/swebench_verified/easy_code_agent.py",
      import.meta.url,
    ));
    const source = readFileSync(adapterPath, "utf8");

    assert.match(
      source,
      /"--provider",\s*"glm",\s*"--model",\s*"glm-5\.3-flash",\s*"--mode",\s*"code",\s*"--thinking-effort",\s*"high",\s*"--approval",\s*"safe",\s*"--yes",\s*"run"/u,
    );
    assert.match(source, /"EASY_CODE_OUTER_SANDBOX":\s*"harbor"/u);
    assert.match(source, /environment\.upload_file\(\s*self\._host_api_key_file,\s*_REMOTE_API_KEY_FILE/u);
    assert.match(
      source,
      /ownership = \(\s*f"chown \{shlex\.quote\(str\(owner\)\)\} "\s*f"\{shlex\.quote\(_REMOTE_SECRETS_DIR\)\} && "/u,
    );
    assert.match(source, /"EASY_CODE_GLM_API_KEY_FILE":\s*_REMOTE_API_KEY_FILE/u);
    assert.match(source, /def _truncate_output\(/u);
    assert.doesNotMatch(source, /ensure_system_dependencies/u);
    assert.doesNotMatch(source, /installed\.node_install/u);
    assert.doesNotMatch(source, /"(?:ZAI|GLM|ZHIPUAI)_API_KEY":\s*self\._api_key/u);
    assert.doesNotMatch(source, /shlex\.quote\(self\._api_key\)/u);
  });

  it("supports a bounded smoke-test prefix without changing task order", () => {
    const root = path.resolve("F:\\easy-code-bench\\swe-bench-verified-50");
    const args = buildHarborRunArgs({
      root,
      runId: "smoke",
      concurrency: 1,
      limit: 2,
    });

    assert.deepEqual(
      valuesAfter(args, "--include-task-name"),
      EXPECTED_INSTANCE_IDS.slice(0, 2).map(
        (instanceId) => `swe-bench/${instanceId}`,
      ),
    );
    assert.throws(
      () => buildHarborRunArgs({ root, runId: "invalid", concurrency: 0 }),
      /concurrency|positive/iu,
    );
    assert.throws(
      () => buildHarborRunArgs({ root, runId: "invalid", concurrency: 1, limit: 51 }),
      /limit|50/iu,
    );
  });

  it("keeps Windows benchmark artifacts on the F drive", () => {
    assert.equal(
      validateSweBenchRoot("F:\\benchmarks\\verified", "win32"),
      "F:\\benchmarks\\verified",
    );
    assert.throws(
      () => validateSweBenchRoot("C:\\benchmarks\\verified", "win32"),
      /F: drive/iu,
    );
  });

  it("preserves Docker Desktop CLI plugin discovery while relocating benchmark caches", () => {
    const root = path.resolve("F:\\easy-code-bench\\swe-bench-verified-50");
    const originalProfile = path.resolve("C:\\Users\\benchmark-user");
    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: originalProfile,
      USERPROFILE: originalProfile,
      PATH: "host-path",
    };
    const originalSnapshot = { ...baseEnvironment };
    const environment = benchmarkEnvironment(root, baseEnvironment);

    assert.equal(environment.HOME, path.join(root, "home"));
    assert.equal(environment.USERPROFILE, path.join(root, "home"));
    assert.equal(environment.XDG_CACHE_HOME, path.join(root, "cache"));
    assert.equal(environment.DOCKER_CONFIG, path.join(originalProfile, ".docker"));
    assert.deepEqual(baseEnvironment, originalSnapshot);

    const explicitDockerConfig = path.resolve("F:\\docker-cli-config");
    assert.equal(
      benchmarkEnvironment(root, {
        HOME: originalProfile,
        USERPROFILE: originalProfile,
        DOCKER_CONFIG: explicitDockerConfig,
      }).DOCKER_CONFIG,
      explicitDockerConfig,
    );

    const launcherCwd = path.resolve("F:\\benchmark-launcher");
    assert.equal(
      benchmarkEnvironment(
        root,
        {
          HOME: originalProfile,
          USERPROFILE: originalProfile,
          DOCKER_CONFIG: ".docker-custom",
        },
        {},
        launcherCwd,
      ).DOCKER_CONFIG,
      path.resolve(launcherCwd, ".docker-custom"),
    );
  });
});
