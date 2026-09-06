import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import {
  SystemKeyringCredentialStore,
  type ApiKeyCredentialStore,
} from "../config/credentials.js";
import {
  PROVIDER_CATALOG,
  providerCatalogEntry,
  sweBenchVerified50Profile,
} from "../models/catalog.js";

const HARBOR_VERSION = "0.16.1";
const SWEBENCH_VERSION = "5.0.2";
const HARBOR_DATASET_REF =
  "sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341";
const HARBOR_AGENT =
  "benchmarks.swebench_verified.easy_code_agent:EasyCodeAgent";
const HARBOR_AGENT_SETUP_TIMEOUT_MULTIPLIER = "4";
export const HARBOR_GLM_CODING_PLAN_API_KEY_FILE =
  "/tmp/easy-code-secrets/glm-coding-plan-api-key";

const SWE_BENCH_MODEL_PROFILE = (() => {
  const profile = sweBenchVerified50Profile();
  const provider = providerCatalogEntry(profile.provider);
  if (provider.provider !== "glm-coding-plan") {
    throw new Error(
      "The SWE-bench profile must use the dedicated GLM Coding Plan provider.",
    );
  }
  if (!provider.models.some((model) => model.id === profile.model)) {
    throw new Error(
      `The SWE-bench model ${JSON.stringify(profile.model)} is absent from provider ${JSON.stringify(provider.provider)}.`,
    );
  }
  if (provider.environment.apiKey.length !== 1) {
    throw new Error(
      "The SWE-bench provider must define one dedicated API-key environment name.",
    );
  }
  const endpoint = new URL(provider.defaultBaseUrl);
  if (endpoint.protocol !== "https:" || !endpoint.hostname) {
    throw new Error("The SWE-bench provider must use a valid HTTPS endpoint.");
  }
  return Object.freeze({
    provider: profile.provider,
    providerLabel: provider.label,
    credentialSlot: provider.credentialSlot,
    configKey: provider.configKey,
    model: profile.model,
    mode: profile.mode,
    thinkingEffort: profile.thinkingEffort,
    baseUrl: provider.defaultBaseUrl,
    apiKeyEnvironment: provider.environment.apiKey,
    allowedHost: endpoint.hostname,
    harborModel: `${profile.provider}/${profile.model}`,
  });
})();

const PROVIDER_CONFIGURATION_ENVIRONMENT_NAMES = Object.freeze(
  PROVIDER_CATALOG.flatMap((provider) =>
    Object.values(provider.environment).flatMap((names) => [...names])
  ),
);

const INSTANCE_IDS = [
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

/**
 * Immutable provenance for the published HAL/Princeton 50-task mini set.
 * Harbor evaluates these exact IDs against the official Verified dataset.
 */
export const SWE_BENCH_VERIFIED_50 = Object.freeze({
  harborDataset: "swe-bench/swe-bench-verified",
  harborDatasetRef: HARBOR_DATASET_REF,
  officialDataset: "SWE-bench/SWE-bench_Verified",
  officialDatasetRevision: "78f471bf655a3137b2e8a75af1501690ec009ec3",
  subsetSource: "MariusHobbhahn/swe-bench-verified-mini",
  subsetRevision: "b316c349947c29963fce3f4a65967c9807a4b673",
  subsetParquetSha256:
    "f9ba19dea78884f1081355d2d8afb671899981f24180aa0c4c1aa14d2c23e855",
  harnessVersion: SWEBENCH_VERSION,
  taskRepoRevision: "3d07b464b7b311a0cbfb5ed5b2d8a3b96f84a33d",
  instanceIds: INSTANCE_IDS,
});

export type TrustedOuterSandbox = "harbor";

/**
 * The benchmark may skip EASY CODE's nested OS sandbox only when Harbor
 * explicitly requests it from inside a Linux Docker container. The opt-in is
 * intentionally environment-only and is not exposed as a general CLI flag.
 */
export function resolveHarborOuterSandbox(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  dockerMarkerExists = existsSync("/.dockerenv"),
): TrustedOuterSandbox | undefined {
  const requested = env.EASY_CODE_OUTER_SANDBOX?.trim();
  if (!requested) return undefined;
  if (requested !== "harbor") {
    throw new Error(
      "EASY_CODE_OUTER_SANDBOX only accepts the trusted Harbor integration.",
    );
  }
  if (platform !== "linux") {
    throw new Error(
      "The Harbor outer-sandbox handoff is valid only inside a Linux container.",
    );
  }
  if (!dockerMarkerExists) {
    throw new Error(
      "The Harbor outer-sandbox handoff requires the Docker container marker.",
    );
  }
  return "harbor";
}

/**
 * Consume the Harbor adapter's owner-only, one-shot Coding Plan secret. The file
 * is removed before any model-controlled command can run, and its value is
 * returned only to the in-process configuration loader.
 *
 * `expectedPath` is injectable solely for filesystem-isolated unit tests. The
 * production call accepts only the fixed container path above.
 */
export function consumeHarborGlmCodingPlanApiKeyFile(
  trustedOuterSandbox: TrustedOuterSandbox | undefined,
  env: NodeJS.ProcessEnv = process.env,
  expectedPath = HARBOR_GLM_CODING_PLAN_API_KEY_FILE,
): string | undefined {
  const requestedPath = env.EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE?.trim();
  if (!requestedPath) return undefined;
  delete env.EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE;
  if (trustedOuterSandbox !== "harbor") {
    throw new Error(
      "EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE is accepted only from the trusted Harbor adapter.",
    );
  }
  if (requestedPath !== expectedPath) {
    throw new Error(
      "The Harbor GLM Coding Plan credential path does not match the pinned adapter path.",
    );
  }

  let credentialRead = false;
  try {
    const metadata = lstatSync(requestedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        "The Harbor GLM Coding Plan credential must be a regular file.",
      );
    }
    if (metadata.size <= 0 || metadata.size > 16_384) {
      throw new Error(
        "The Harbor GLM Coding Plan credential file has an invalid size.",
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(
        "The Harbor GLM Coding Plan credential file must be owner-only (mode 0600).",
      );
    }
    const apiKey = readFileSync(requestedPath, "utf8").trim();
    if (!apiKey) {
      throw new Error("The Harbor GLM Coding Plan credential file is empty.");
    }
    credentialRead = true;
    return apiKey;
  } finally {
    try {
      unlinkSync(requestedPath);
    } catch {
      if (credentialRead) {
        throw new Error(
          "Unable to remove the one-shot Harbor GLM Coding Plan credential; refusing to start the Agent.",
        );
      }
    }
  }
}

export interface HarborRunOptions {
  readonly root: string;
  readonly runId: string;
  readonly concurrency: number;
  readonly limit?: number;
  readonly platform?: NodeJS.Platform;
}

export function buildHarborRunArgs(options: HarborRunOptions): string[] {
  const concurrency = requirePositiveInteger(options.concurrency, "concurrency");
  const limit = options.limit === undefined
    ? INSTANCE_IDS.length
    : requirePositiveInteger(options.limit, "limit");
  if (limit > INSTANCE_IDS.length) {
    throw new Error(`limit must be between 1 and ${String(INSTANCE_IDS.length)}.`);
  }
  const runId = options.runId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) {
    throw new Error(
      "runId must start with an alphanumeric character and contain only letters, numbers, ., _, or -.",
    );
  }
  const root = validateSweBenchRoot(
    options.root,
    options.platform ?? process.platform,
  );
  const args = [
    "run",
    "--dataset",
    `${SWE_BENCH_VERIFIED_50.harborDataset}@${SWE_BENCH_VERIFIED_50.harborDatasetRef}`,
    "--agent",
    HARBOR_AGENT,
    "--model",
    SWE_BENCH_MODEL_PROFILE.harborModel,
    "--jobs-dir",
    path.join(root, "jobs"),
    "--job-name",
    runId,
    "--n-concurrent",
    String(concurrency),
    "--n-attempts",
    "1",
    "--agent-setup-timeout-multiplier",
    HARBOR_AGENT_SETUP_TIMEOUT_MULTIPLIER,
    "--yes",
    "--allow-agent-host",
    SWE_BENCH_MODEL_PROFILE.allowedHost,
  ];
  for (const instanceId of INSTANCE_IDS.slice(0, limit)) {
    args.push("--include-task-name", `swe-bench/${instanceId}`);
  }
  return args;
}

export interface SweBenchCommandRuntime {
  readonly credentialStore?: ApiKeyCredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: Pick<NodeJS.WritableStream, "write">;
  readonly stderr?: Pick<NodeJS.WritableStream, "write">;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly packageRoot?: string;
  readonly setExitCode?: (code: number) => void;
}

interface BenchmarkDoctorCheck {
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export function defaultSweBenchRoot(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = os.homedir(),
): string {
  return platform === "win32"
    ? path.win32.join("F:\\", "easy-code-bench", "swe-bench-verified-50")
    : path.join(homeDirectory, "easy-code-bench", "swe-bench-verified-50");
}

export function validateSweBenchRoot(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = platform === "win32"
    ? path.win32.resolve(value)
    : path.resolve(value);
  if (
    platform === "win32" &&
    path.win32.parse(resolved).root.toUpperCase() !== "F:\\"
  ) {
    throw new Error(
      `SWE-bench data must stay on the F: drive; received ${resolved}.`,
    );
  }
  return resolved;
}

export interface StagedBenchmarkCredential {
  readonly filename: string;
  cleanup(): void;
}

/**
 * Stage one shared host Coding Plan credential for concurrent Harbor trials. On Windows,
 * the directory DACL is restricted before secret bytes are ever written.
 */
export async function stageBenchmarkCredential(
  rootValue: string,
  apiKeyValue: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<StagedBenchmarkCredential> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const root = validateSweBenchRoot(rootValue, platform);
  const apiKey = apiKeyValue.trim();
  if (!apiKey || Buffer.byteLength(apiKey, "utf8") > 16_384) {
    throw new Error("The GLM Coding Plan credential has an invalid size.");
  }

  const temporaryRoot = path.join(root, "tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(
    path.join(temporaryRoot, "glm-coding-plan-secret-"),
  );
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    if (platform === "win32") {
      const systemRoot = env.SystemRoot?.trim() || "C:\\Windows";
      const whoami = path.win32.join(systemRoot, "System32", "whoami.exe");
      const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");
      if (!existsSync(whoami) || !existsSync(icacls)) {
        throw new Error("Windows ACL tools are unavailable; refusing to stage the credential.");
      }
      const identity = await runCaptured(
        whoami,
        ["/user", "/fo", "csv", "/nh"],
        { cwd: root, env },
      );
      const sid = identity.code === 0
        ? identity.stdout.match(/"(S-[0-9]+(?:-[0-9]+)+)"\s*$/u)?.[1]
        : undefined;
      if (!sid) {
        throw new Error(
          `Unable to resolve the current Windows SID: ${compactProcessError(identity)}`,
        );
      }
      const acl = await runCaptured(
        icacls,
        [
          directory,
          "/inheritance:r",
          "/grant:r",
          `*${sid}:(OI)(CI)F`,
          "/grant:r",
          "*S-1-5-18:(OI)(CI)F",
        ],
        { cwd: root, env },
      );
      if (acl.code !== 0) {
        throw new Error(
          `Unable to apply an owner-only Windows ACL: ${compactProcessError(acl)}`,
        );
      }
    } else {
      chmodSync(directory, 0o700);
    }

    const filename = path.join(directory, "glm-coding-plan-api-key");
    const noFollow = platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const descriptor = openSync(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      writeSync(descriptor, apiKey, null, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (platform !== "win32") {
      chmodSync(filename, 0o600);
      if ((lstatSync(filename).mode & 0o077) !== 0) {
        throw new Error("The staged credential is not owner-only.");
      }
    }
    return { filename, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function registerSweBenchCommands(
  program: Command,
  runtime: SweBenchCommandRuntime = {},
): Command {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const packageRoot = runtime.packageRoot ?? findPackageRoot();
  const credentialStore = runtime.credentialStore ?? new SystemKeyringCredentialStore();
  const setExitCode = runtime.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  const writeLine = (value: string): void => {
    stdout.write(`${value}\n`);
  };

  const benchmark = program
    .command("benchmark")
    .description("run reproducible coding-agent benchmarks");
  const sweBench = benchmark
    .command("swe-bench")
    .description(
      `evaluate ${SWE_BENCH_MODEL_PROFILE.model} via ${SWE_BENCH_MODEL_PROFILE.providerLabel} ` +
        "on the pinned 50-task Verified Mini subset",
    )
    .addHelpText(
      "after",
      "\nThis integration evaluates the published HAL/community 50-task subset " +
        "against the official SWE-bench Verified Harbor dataset. It is not the full 500-task score.\n",
    );

  sweBench
    .command("info")
    .description("show the immutable subset and harness provenance")
    .action(() => {
      writeLine(`Subset: ${SWE_BENCH_VERIFIED_50.subsetSource}`);
      writeLine(`Subset revision: ${SWE_BENCH_VERIFIED_50.subsetRevision}`);
      writeLine(`Official dataset: ${SWE_BENCH_VERIFIED_50.officialDataset}`);
      writeLine(`Official revision: ${SWE_BENCH_VERIFIED_50.officialDatasetRevision}`);
      writeLine(`Tasks: ${String(SWE_BENCH_VERIFIED_50.instanceIds.length)}`);
      writeLine(
        `Model profile: ${SWE_BENCH_MODEL_PROFILE.harborModel} / ` +
          `${SWE_BENCH_MODEL_PROFILE.providerLabel} / ${SWE_BENCH_MODEL_PROFILE.mode} / ` +
          SWE_BENCH_MODEL_PROFILE.thinkingEffort,
      );
      writeLine(`Provider endpoint: ${SWE_BENCH_MODEL_PROFILE.baseUrl}`);
    });

  sweBench
    .command("setup")
    .description("create the pinned Python benchmark environment on the F drive")
    .option("--root <path>", "benchmark data root", defaultSweBenchRoot(platform, runtime.homeDirectory))
    .option("--python <path>", "Python 3.12+ executable", "python")
    .action(async (options: { root: string; python: string }) => {
      const root = validateSweBenchRoot(options.root, platform);
      prepareBenchmarkDirectories(root);
      const childEnv = benchmarkEnvironment(root, env);
      writeLine(`Benchmark root: ${root}`);
      writeLine("Creating the isolated Python environment...");
      await runInherited(options.python, ["-m", "venv", benchmarkVenv(root)], {
        cwd: root,
        env: childEnv,
      });
      const python = benchmarkPython(root, platform);
      await runInherited(python, ["-m", "pip", "install", "--upgrade", "pip"], {
        cwd: root,
        env: childEnv,
      });
      await runInherited(
        python,
        [
          "-m",
          "pip",
          "install",
          `harbor==${HARBOR_VERSION}`,
          `swebench==${SWEBENCH_VERSION}`,
        ],
        { cwd: root, env: childEnv },
      );
      writeLine(
        `Installed harbor==${HARBOR_VERSION} and swebench==${SWEBENCH_VERSION} under ${benchmarkVenv(root)}.`,
      );
    });

  sweBench
    .command("doctor")
    .description("check Docker, Harbor, the pinned manifest, and the GLM credential")
    .option("--root <path>", "benchmark data root", defaultSweBenchRoot(platform, runtime.homeDirectory))
    .action(async (options: { root: string }) => {
      const root = validateSweBenchRoot(options.root, platform);
      const childEnv = benchmarkEnvironment(root, env, {
        PYTHONPATH: prependPath(packageRoot, env.PYTHONPATH),
      });
      const checks: BenchmarkDoctorCheck[] = [];
      const docker = await runCaptured("docker", ["version", "--format", "{{.Server.Version}}"], {
        cwd: packageRoot,
        env: childEnv,
      });
      checks.push({
        label: "Docker Engine",
        status: docker.code === 0 ? "ok" : "fail",
        detail: docker.code === 0 ? docker.stdout.trim() || "ready" : compactProcessError(docker),
      });
      const dockerPlatform = docker.code === 0
        ? await runCaptured(
            "docker",
            ["info", "--format", "{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}"],
            { cwd: packageRoot, env: childEnv },
          )
        : { code: 1, stdout: "", stderr: "Docker Engine is unavailable." };
      const dockerParts = dockerPlatform.stdout.trim().split("|");
      const dockerTargetOk = dockerPlatform.code === 0 &&
        dockerParts[0]?.toLowerCase() === "linux" &&
        ["amd64", "x86_64"].includes(dockerParts[1]?.toLowerCase() ?? "");
      checks.push({
        label: "Docker task platform",
        status: dockerTargetOk ? "ok" : "fail",
        detail: dockerTargetOk
          ? `${dockerParts[0]}/${dockerParts[1]} (${dockerParts[2] || "storage path unavailable"})`
          : compactProcessError(dockerPlatform),
      });
      // Compose plugin discovery is independent of daemon readiness. Check it
      // even when the Engine is stopped so doctor reports the actionable cause.
      const dockerCompose = await runCaptured(
        "docker",
        ["compose", "--project-name", "easy-code-doctor", "version"],
        { cwd: packageRoot, env: childEnv },
      );
      const dockerComposeVersion = extractSemanticVersion(
        `${dockerCompose.stdout}\n${dockerCompose.stderr}`,
      );
      const dockerComposeReady = dockerCompose.code === 0 &&
        versionAtLeast(dockerComposeVersion, "2.0.0");
      checks.push({
        label: "Docker Compose >=2",
        status: dockerComposeReady ? "ok" : "fail",
        detail: dockerComposeReady
          ? dockerComposeVersion ?? "ready"
          : compactProcessError(dockerCompose),
      });
      const harbor = await runCaptured(benchmarkHarbor(root, platform), ["--version"], {
        cwd: packageRoot,
        env: childEnv,
      });
      const harborVersion = extractSemanticVersion(`${harbor.stdout}\n${harbor.stderr}`);
      checks.push({
        label: `Harbor ${HARBOR_VERSION}`,
        status: harbor.code === 0 && harborVersion === HARBOR_VERSION ? "ok" : "fail",
        detail: harbor.code === 0
          ? harborVersion ?? "version was not reported"
          : compactProcessError(harbor),
      });
      const python = await runCaptured(benchmarkPython(root, platform), ["--version"], {
        cwd: packageRoot,
        env: childEnv,
      });
      const pythonVersion = extractSemanticVersion(`${python.stdout}\n${python.stderr}`);
      const pythonReady = python.code === 0 && versionAtLeast(pythonVersion, "3.12.0");
      checks.push({
        label: "Benchmark Python >=3.12",
        status: pythonReady ? "ok" : "fail",
        detail: python.code === 0
          ? pythonVersion ?? "version was not reported"
          : compactProcessError(python),
      });
      const swebench = pythonReady
        ? await runCaptured(
            benchmarkPython(root, platform),
            [
              "-c",
              "import importlib.metadata as m; print(m.version('swebench'))",
            ],
            { cwd: packageRoot, env: childEnv },
          )
        : { code: 1, stdout: "", stderr: "Benchmark Python is unavailable." };
      checks.push({
        label: `swebench ${SWEBENCH_VERSION}`,
        status: swebench.code === 0 && swebench.stdout.trim() === SWEBENCH_VERSION
          ? "ok"
          : "fail",
        detail: swebench.code === 0
          ? swebench.stdout.trim() || "version was not reported"
          : compactProcessError(swebench),
      });
      const adapter = pythonReady
        ? await runCaptured(
            benchmarkPython(root, platform),
            [
              "-c",
              "from benchmarks.swebench_verified.easy_code_agent import EasyCodeAgent; print(EasyCodeAgent.name())",
            ],
            { cwd: packageRoot, env: childEnv },
          )
        : { code: 1, stdout: "", stderr: "Benchmark Python is unavailable." };
      checks.push({
        label: "EASY CODE Harbor adapter",
        status: adapter.code === 0 && adapter.stdout.trim() === "easy-code" ? "ok" : "fail",
        detail: adapter.code === 0
          ? adapter.stdout.trim() || "adapter name was not reported"
          : compactProcessError(adapter),
      });
      const manifest = readPinnedManifest(packageRoot);
      checks.push({
        label: "Pinned 50-task manifest",
        status: manifest.ok ? "ok" : "fail",
        detail: manifest.detail,
      });
      checks.push(...inspectBenchmarkStorage(root, platform, env));
      let hasCredential = Boolean(benchmarkApiKeyFromEnvironment(env));
      if (!hasCredential) {
        try {
          hasCredential = Boolean(
            await credentialStore.get(SWE_BENCH_MODEL_PROFILE.credentialSlot),
          );
        } catch {
          hasCredential = false;
        }
      }
      checks.push({
        label: `${SWE_BENCH_MODEL_PROFILE.providerLabel} API key`,
        status: hasCredential ? "ok" : "fail",
        detail: hasCredential ? "configured (value hidden)" : "not available",
      });
      writeLine(`Benchmark root: ${root}`);
      for (const check of checks) {
        writeLine(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
      }
      if (checks.some((check) => check.status === "fail")) setExitCode(2);
    });

  sweBench
    .command("prepare")
    .description("pack the current EASY CODE build into the F-drive benchmark root")
    .option("--root <path>", "benchmark data root", defaultSweBenchRoot(platform, runtime.homeDirectory))
    .action(async (options: { root: string }) => {
      const root = validateSweBenchRoot(options.root, platform);
      const packagePath = await packEasyCode(packageRoot, root, env, platform);
      writeLine(`Prepared package: ${packagePath}`);
    });

  sweBench
    .command("run")
    .description("run a smoke test or the complete pinned 50-task subset")
    .option("--root <path>", "benchmark data root", defaultSweBenchRoot(platform, runtime.homeDirectory))
    .option("--run-id <id>", "stable Harbor job name", defaultRunId())
    .option("--concurrency <count>", "parallel task count", parsePositiveOption, 1)
    .option("--limit <count>", "ordered prefix of the 50-task set", parsePositiveOption, 1)
    .option("--confirm-full-run", "confirm the API cost of starting all 50 tasks")
    .option("--package <path>", "existing local EASY CODE npm .tgz")
    .option("--dry-run", "print the exact non-secret Harbor invocation without running it")
    .action(async (options: {
      root: string;
      runId: string;
      concurrency: number;
      limit: number;
      package?: string;
      dryRun?: boolean;
      confirmFullRun?: boolean;
    }) => {
      const root = validateSweBenchRoot(options.root, platform);
      const args = buildHarborRunArgs({
        root,
        runId: options.runId,
        concurrency: options.concurrency,
        limit: options.limit,
        platform,
      });
      writeLine(`Benchmark root: ${root}`);
      writeLine(`Tasks: ${String(options.limit)} / 50; concurrency: ${String(options.concurrency)}`);
      writeLine(`Harbor argv: ${JSON.stringify(args)}`);
      if (options.dryRun) {
        writeLine("Dry run only; no package was built, no API key was read, and no task was started.");
        return;
      }
      if (options.limit === INSTANCE_IDS.length && !options.confirmFullRun) {
        throw new Error(
          "A 50-task run can consume substantial API credits. Re-run with --confirm-full-run.",
        );
      }

      prepareBenchmarkDirectories(root);
      const composeEnvironment = benchmarkEnvironment(root, env);
      const compose = await runCaptured(
        "docker",
        ["compose", "--project-name", "easy-code-preflight", "version"],
        { cwd: packageRoot, env: composeEnvironment },
      );
      const composeVersion = extractSemanticVersion(`${compose.stdout}\n${compose.stderr}`);
      if (compose.code !== 0 || !versionAtLeast(composeVersion, "2.0.0")) {
        throw new Error(
          `Docker Compose v2 preflight failed: ${compactProcessError(compose)}. ` +
            "Run easy-code benchmark swe-bench doctor before retrying.",
        );
      }
      const packagePath = options.package
        ? validatePackagePath(options.package)
        : await packEasyCode(packageRoot, root, env, platform);
      const apiKey = benchmarkApiKeyFromEnvironment(env) ||
        (await credentialStore.get(SWE_BENCH_MODEL_PROFILE.credentialSlot));
      if (!apiKey) {
        throw new Error(
          `No ${SWE_BENCH_MODEL_PROFILE.providerLabel} API key is available. ` +
            `Run easy-code config set ${SWE_BENCH_MODEL_PROFILE.configKey} first.`,
        );
      }
      const stagedCredential = await stageBenchmarkCredential(root, apiKey, {
        platform,
        env,
      });
      const childEnv = benchmarkEnvironment(root, env, {
        EASY_CODE_GLM_CODING_PLAN_KEY_FILE: stagedCredential.filename,
        EASY_CODE_PACKAGE_PATH: packagePath,
        PYTHONPATH: prependPath(packageRoot, env.PYTHONPATH),
      });
      writeLine(
        "Starting Harbor. It receives only an ACL-protected credential-file path; the key is never printed.",
      );
      try {
        await runInherited(benchmarkHarbor(root, platform), args, {
          cwd: root,
          env: childEnv,
        });
      } finally {
        stagedCredential.cleanup();
      }
    });

  sweBench.action(() => sweBench.outputHelp());
  benchmark.action(() => benchmark.outputHelp());
  return benchmark;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parsePositiveOption(value: string): number {
  const parsed = Number(value);
  return requirePositiveInteger(parsed, "option value");
}

function benchmarkVenv(root: string): string {
  return path.join(root, "python");
}

function benchmarkPython(root: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(benchmarkVenv(root), "Scripts", "python.exe")
    : path.join(benchmarkVenv(root), "bin", "python");
}

function benchmarkHarbor(root: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(benchmarkVenv(root), "Scripts", "harbor.exe")
    : path.join(benchmarkVenv(root), "bin", "harbor");
}

function prepareBenchmarkDirectories(root: string): void {
  for (const directory of [
    root,
    path.join(root, "cache"),
    path.join(root, "cache", "huggingface"),
    path.join(root, "cache", "npm"),
    path.join(root, "cache", "pip"),
    path.join(root, "cache", "uv"),
    path.join(root, "home"),
    path.join(root, "jobs"),
    path.join(root, "packages"),
    path.join(root, "tmp"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}

export function benchmarkEnvironment(
  root: string,
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
  launcherCwd = process.cwd(),
): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const originalHome = base.USERPROFILE?.trim() || base.HOME?.trim() || os.homedir();
  const explicitDockerConfig = base.DOCKER_CONFIG?.trim();
  const dockerConfig = explicitDockerConfig
    ? path.resolve(launcherCwd, explicitDockerConfig)
    : path.join(originalHome, ".docker");
  const environment: NodeJS.ProcessEnv = {
    ...base,
    ...extra,
    HOME: home,
    USERPROFILE: home,
    HF_HOME: path.join(root, "cache", "huggingface"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    PIP_CACHE_DIR: path.join(root, "cache", "pip"),
    UV_CACHE_DIR: path.join(root, "cache", "uv"),
    npm_config_cache: path.join(root, "cache", "npm"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    PYTHONUTF8: "1",
  };
  // Provider credentials are consumed by the launcher and staged through an
  // owner-only one-shot file. Never expose raw keys to Docker preflight,
  // package builds, Harbor, or any other benchmark child process.
  for (const name of [
    ...PROVIDER_CONFIGURATION_ENVIRONMENT_NAMES,
    "EASY_CODE_GLM_API_KEY_FILE",
    "EASY_CODE_GLM_CODING_PLAN_API_KEY_FILE",
  ]) {
    delete environment[name];
  }
  // Only the launcher's trusted staging step may add this host file path.
  if (!("EASY_CODE_GLM_CODING_PLAN_KEY_FILE" in extra)) {
    delete environment.EASY_CODE_GLM_CODING_PLAN_KEY_FILE;
  }
  // Docker Desktop installs Compose v2 as a CLI plugin below the real user
  // profile. Preserve only the host CLI configuration location when moving
  // benchmark caches and Harbor's HOME to F:, otherwise `docker compose`
  // silently disappears even though `docker version` continues to work.
  environment.DOCKER_CONFIG = dockerConfig;
  return environment;
}

function benchmarkApiKeyFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of SWE_BENCH_MODEL_PROFILE.apiKeyEnvironment) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function prependPath(value: string, existing: string | undefined): string {
  return existing ? `${value}${path.delimiter}${existing}` : value;
}

function extractSemanticVersion(value: string): string | undefined {
  return value.match(/(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)(?:[^0-9]|$)/u)?.[1];
}

function versionAtLeast(
  actual: string | undefined,
  minimum: string,
): boolean {
  if (!actual) return false;
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function inspectBenchmarkStorage(
  root: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): BenchmarkDoctorCheck[] {
  const checks: BenchmarkDoctorCheck[] = [];
  try {
    const volume = platform === "win32"
      ? path.win32.parse(root).root
      : path.parse(root).root;
    const stats = statfsSync(volume);
    const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
    const availableGiB = Number(availableBytes / (1024n ** 3n));
    checks.push({
      label: "Benchmark volume free space",
      status: availableBytes >= 120n * (1024n ** 3n) ? "ok" : "fail",
      detail: `${String(availableGiB)} GiB available on ${volume}`,
    });
  } catch (error) {
    checks.push({
      label: "Benchmark volume free space",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (platform !== "win32") return checks;
  const appData = env.APPDATA?.trim();
  const settingsFiles = appData
    ? [
        path.win32.join(appData, "Docker", "settings-store.json"),
        path.win32.join(appData, "Docker", "settings.json"),
      ]
    : [];
  let dockerImageLocation: string | undefined;
  for (const filename of settingsFiles) {
    if (!existsSync(filename)) continue;
    try {
      dockerImageLocation = findStringSetting(
        JSON.parse(readFileSync(filename, "utf8")) as unknown,
        new Set([
          "diskimagelocation",
          "wslenginedataroot",
          "virtualmachinediskpath",
        ]),
      );
      if (dockerImageLocation) break;
    } catch {
      // A warning below is safer than trusting malformed Docker settings.
    }
  }
  if (!dockerImageLocation) {
    checks.push({
      label: "Docker Desktop disk image on F drive",
      status: "warn",
      detail: "location could not be verified automatically; confirm it in Docker Desktop settings",
    });
    return checks;
  }
  const resolvedLocation = path.win32.resolve(dockerImageLocation);
  const onFDrive = path.win32.parse(resolvedLocation).root.toUpperCase() === "F:\\";
  checks.push({
    label: "Docker Desktop disk image on F drive",
    status: onFDrive ? "ok" : "fail",
    detail: resolvedLocation,
  });
  return checks;
}

function findStringSetting(
  value: unknown,
  keys: ReadonlySet<string>,
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
    const found = findStringSetting(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function defaultRunId(now = new Date()): string {
  return `${SWE_BENCH_MODEL_PROFILE.provider}-${SWE_BENCH_MODEL_PROFILE.model}-` +
    now.toISOString().replace(/[:.]/gu, "-");
}

function findPackageRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate EASY CODE's package root.");
    }
    current = parent;
  }
}

function readPinnedManifest(packageRoot: string): { ok: boolean; detail: string } {
  const filename = path.join(
    packageRoot,
    "benchmarks",
    "swebench_verified",
    "subset-50.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as {
      instance_ids?: unknown;
      official_source?: { harbor_dataset_ref?: unknown };
    };
    if (
      Array.isArray(parsed.instance_ids) &&
      JSON.stringify(parsed.instance_ids) === JSON.stringify(INSTANCE_IDS) &&
      parsed.official_source?.harbor_dataset_ref === HARBOR_DATASET_REF
    ) {
      return {
        ok: true,
        detail: `50 exact ordered IDs; Harbor dataset ${HARBOR_DATASET_REF}`,
      };
    }
    return {
      ok: false,
      detail: "manifest IDs or Harbor dataset digest do not match the compiled pin",
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function packEasyCode(
  packageRoot: string,
  root: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  prepareBenchmarkDirectories(root);
  const packagesDir = path.join(root, "packages");
  const npm = resolveNpmInvocation(platform, process.execPath, env);
  const sourceCheckout = existsSync(path.join(packageRoot, "src", "index.ts")) &&
    existsSync(path.join(packageRoot, "tsconfig.json"));
  if (sourceCheckout) {
    await runInherited(
      npm.executable,
      [...npm.argsPrefix, "run", "build"],
      { cwd: packageRoot, env: benchmarkEnvironment(root, env) },
    );
  } else if (!existsSync(path.join(packageRoot, "dist", "index.js"))) {
    throw new Error(
      "The installed EASY CODE package has no compiled dist/index.js to benchmark.",
    );
  }
  const result = await runCaptured(
    npm.executable,
    [
      ...npm.argsPrefix,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packagesDir,
    ],
    { cwd: packageRoot, env: benchmarkEnvironment(root, env) },
  );
  if (result.code !== 0) {
    throw new Error(`Unable to package EASY CODE: ${compactProcessError(result)}`);
  }
  let filename: string | undefined;
  try {
    const value = JSON.parse(result.stdout) as Array<{ filename?: string }>;
    filename = value[0]?.filename;
  } catch {
    // Fall through to the directory scan for npm versions with non-JSON noise.
  }
  if (!filename) {
    filename = readdirSync(packagesDir)
      .filter((entry) => entry.endsWith(".tgz"))
      .sort()
      .at(-1);
  }
  if (!filename) throw new Error("npm pack completed without producing a .tgz file.");
  return validatePackagePath(path.join(packagesDir, filename));
}

export interface StructuredNpmInvocation {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
}

export function resolveNpmInvocation(
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): StructuredNpmInvocation {
  const explicitCli = env.npm_execpath?.trim();
  const candidates = [
    explicitCli,
    path.join(path.dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(
      path.dirname(nodeExecutable),
      "..",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli) {
    return { executable: nodeExecutable, argsPrefix: [npmCli] };
  }
  if (platform !== "win32") {
    return { executable: "npm", argsPrefix: [] };
  }
  throw new Error(
    "Unable to locate npm-cli.js beside the active Node.js runtime; refusing to invoke a shell shim.",
  );
}

function validatePackagePath(value: string): string {
  const resolved = path.resolve(value);
  if (!resolved.toLowerCase().endsWith(".tgz") || !existsSync(resolved)) {
    throw new Error(`EASY CODE package does not exist or is not a .tgz: ${resolved}`);
  }
  return resolved;
}

interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CapturedProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCaptured(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<CapturedProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 1_000_000) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 1_000_000) stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runInherited(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with code ${String(code ?? 1)}.`));
    });
  });
}

function compactProcessError(result: CapturedProcessResult): string {
  const value = (result.stderr || result.stdout || `exit ${String(result.code)}`)
    .replace(/\s+/gu, " ")
    .trim();
  return value.slice(0, 240);
}
