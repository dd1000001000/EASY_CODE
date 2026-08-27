import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MAX_SEQUENCE_LENGTH,
  EMBEDDING_MODEL_MANIFEST as PROVIDER_MODEL_MANIFEST,
  type EmbeddingModelDependencies,
  type EmbeddingSession,
  type EmbeddingTokenizer,
  LocalEmbeddingModel,
} from "../src/memory/embedding-model.js";
import { describe, it } from "./harness.js";

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface EmbeddingManifest {
  model: string;
  revision: string;
  dimension: number;
  maxSequenceLength: number;
  pooling: "masked-mean";
  normalized: true;
  files: ManifestFile[];
}

interface ModelResult {
  modelDirectory: string;
  manifestPath: string;
  manifest: EmbeddingManifest;
  downloaded?: string[];
  reused?: string[];
}

interface EmbeddingModelModule {
  EMBEDDING_MODEL_MANIFEST: EmbeddingManifest;
  acquireModelInstallLock(
    modelDirectory: string,
    options?: {
      fsp?: unknown;
      lockToken?: string;
      sleep?: (milliseconds: number) => Promise<void>;
    },
  ): Promise<{ release(): Promise<void> }>;
  downloadHttpsFile(
    input: {
      url: string;
      destinationPath: string;
      size: number;
      sha256: string;
    },
    options?: {
      openResponse?: (url: string) => Promise<Readable & { headers?: Record<string, string> }>;
      randomToken?: () => string;
      deadlineMs?: number;
      idleTimeoutMs?: number;
    },
  ): Promise<{ path: string; size: number; sha256: string }>;
  prepareEmbeddingModel(options?: {
    manifest?: EmbeddingManifest;
    modelDirectory?: string;
    cacheDirectory?: string;
    loadEnvPaths?: () => Promise<unknown>;
    openResponse?: (url: string) => Promise<Readable & { headers?: Record<string, string> }>;
    randomToken?: () => string;
    downloadFile?: (input: {
      url: string;
      destinationPath: string;
      size: number;
      sha256: string;
    }) => Promise<unknown>;
    fsp?: unknown;
    sleep?: (milliseconds: number) => Promise<void>;
  }): Promise<ModelResult>;
  resolveEmbeddingModelDirectory(options?: {
    cacheDirectory?: string;
    loadEnvPaths?: () => Promise<unknown>;
  }): Promise<string>;
  serializedManifest(manifest?: EmbeddingManifest): string;
  verifyEmbeddingModel(options?: {
    manifest?: EmbeddingManifest;
    modelDirectory?: string;
  }): Promise<ModelResult>;
}

interface PostinstallValidationModule {
  validateEmbeddingStack(
    model: {
      modelDirectory: string;
      manifest: { dimension: number; maxSequenceLength: number };
    },
    options?: {
      readFile?: (file: string, encoding: string) => Promise<string>;
      loadTokenizer?: () => Promise<unknown>;
      loadOnnx?: () => Promise<unknown>;
      loadOrama?: () => Promise<unknown>;
    },
  ): Promise<unknown>;
  validateOrama(options?: { loadOrama?: () => Promise<unknown> }): Promise<void>;
}

const require = createRequire(import.meta.url);
const embeddingModel = require(
  path.join(process.cwd(), "scripts", "embedding-model.cjs"),
) as EmbeddingModelModule;
const postinstall = require(
  path.join(process.cwd(), "scripts", "postinstall.cjs"),
) as PostinstallValidationModule;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureManifest(files: Array<{ path: string; content: Buffer }>): EmbeddingManifest {
  return {
    model: "Fixture/embedding-model",
    revision: "a".repeat(40),
    dimension: 4,
    maxSequenceLength: 8,
    pooling: "masked-mean",
    normalized: true,
    files: files.map((file) => ({
      path: file.path,
      size: file.content.length,
      sha256: sha256(file.content),
    })),
  };
}

function response(contents: Buffer): Readable & { headers: Record<string, string> } {
  const midpoint = Math.max(1, Math.floor(contents.length / 2));
  return Object.assign(
    Readable.from([contents.subarray(0, midpoint), contents.subarray(midpoint)]),
    { headers: { "content-length": String(contents.length) } },
  );
}

describe("embedding model installer", () => {
  it("pins the complete model manifest and resolves the env-paths cache", async () => {
    const manifest = embeddingModel.EMBEDDING_MODEL_MANIFEST;
    assert.equal(manifest.revision, "2c4055b12046f11709e9df2c122e59ffbdc2f900");
    assert.equal(manifest.dimension, 384);
    assert.equal(manifest.maxSequenceLength, 128);
    assert.equal(
      manifest.files.reduce((total, file) => total + file.size, 0),
      135_392_488,
    );

    const cache = path.join(tmpdir(), "easy-code-cache-fixture");
    let receivedName = "";
    const resolved = await embeddingModel.resolveEmbeddingModelDirectory({
      loadEnvPaths: async () => ({
        default: (name: string, options: { suffix: string }) => {
          receivedName = `${name}:${options.suffix}`;
          return { cache };
        },
      }),
    });
    assert.equal(receivedName, "easy-code:");
    assert.equal(
      resolved,
      path.resolve(cache, "models", "paraphrase-multilingual-MiniLM-L12-v2"),
    );
  });

  it("downloads to verified atomic files, writes the manifest, and reuses a complete cache", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-model-"));
    const first = { path: "config.json", content: Buffer.from("fixture-config") };
    const second = { path: "onnx/model_quantized.onnx", content: Buffer.from("fixture-model") };
    const manifest = fixtureManifest([first, second]);
    const byPath = new Map([first, second].map((file) => [file.path, file.content]));
    let requests = 0;
    try {
      const prepared = await embeddingModel.prepareEmbeddingModel({
        manifest,
        modelDirectory: root,
        randomToken: () => `token-${requests}`,
        openResponse: async (url) => {
          requests += 1;
          const marker = `/resolve/${manifest.revision}/`;
          const relative = decodeURIComponent(new URL(url).pathname.split(marker)[1] ?? "");
          const contents = byPath.get(relative);
          if (!contents) throw new Error(`unexpected fixture URL ${url}`);
          return response(contents);
        },
      });
      assert.deepEqual(prepared.downloaded, [first.path, second.path]);
      assert.deepEqual(prepared.reused, []);
      assert.equal(requests, 2);
      assert.equal(readFileSync(path.join(root, first.path), "utf8"), first.content.toString());
      assert.equal(readFileSync(path.join(root, second.path), "utf8"), second.content.toString());
      assert.equal(
        readFileSync(path.join(root, "manifest.json"), "utf8"),
        embeddingModel.serializedManifest(manifest),
      );

      const reused = await embeddingModel.prepareEmbeddingModel({
        manifest,
        modelDirectory: root,
        randomToken: () => "reuse-token",
        openResponse: async () => {
          throw new Error("a complete cache must not access the network");
        },
      });
      assert.deepEqual(reused.downloaded, []);
      assert.deepEqual(reused.reused, [first.path, second.path]);
      await embeddingModel.verifyEmbeddingModel({ manifest, modelDirectory: root });

      writeFileSync(path.join(root, first.path), "tampered", "utf8");
      await assert.rejects(
        embeddingModel.verifyEmbeddingModel({ manifest, modelDirectory: root }),
        /size|SHA256/iu,
      );
      assert.equal(
        readdirSync(root).some((name) => name.includes(".download-") || name.includes(".write-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call the response timeout wrapper after Node detaches its socket", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-detached-response-"));
    const destinationPath = path.join(root, "config.json");
    const contents = Buffer.from("detached-socket-download");
    let responseTimeoutCalls = 0;
    const detachedResponse = Object.assign(response(contents), {
      socket: null,
      setTimeout: () => {
        responseTimeoutCalls += 1;
        throw new TypeError("Cannot read properties of null (reading 'setTimeout')");
      },
    });

    try {
      const downloaded = await embeddingModel.downloadHttpsFile(
        {
          url: "https://example.invalid/config.json",
          destinationPath,
          size: contents.length,
          sha256: sha256(contents),
        },
        {
          randomToken: () => "detached-socket",
          openResponse: async () => detachedResponse,
        },
      );
      assert.equal(downloaded.size, contents.length);
      assert.deepEqual(readFileSync(destinationPath), contents);
      assert.equal(responseTimeoutCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent preparations for the same model directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-lock-"));
    const asset = { path: "config.json", content: Buffer.from("locked-download") };
    const manifest = fixtureManifest([asset]);
    const preparations: Array<Promise<ModelResult>> = [];
    let releaseDownload = () => {};
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let reportDownloadStarted = () => {};
    const downloadStarted = new Promise<void>((resolve) => {
      reportDownloadStarted = resolve;
    });
    let reportContention = () => {};
    const contentionObserved = new Promise<void>((resolve) => {
      reportContention = resolve;
    });
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    let downloadCalls = 0;
    const downloadFile = async (input: { destinationPath: string }) => {
      downloadCalls += 1;
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      reportDownloadStarted();
      try {
        await downloadGate;
        mkdirSync(path.dirname(input.destinationPath), { recursive: true });
        writeFileSync(input.destinationPath, asset.content);
      } finally {
        activeDownloads -= 1;
      }
    };

    try {
      const first = embeddingModel.prepareEmbeddingModel({
        manifest,
        modelDirectory: root,
        downloadFile,
      });
      preparations.push(first);
      await downloadStarted;

      let contentionReported = false;
      const second = embeddingModel.prepareEmbeddingModel({
        manifest,
        modelDirectory: root,
        downloadFile,
        sleep: async () => {
          if (!contentionReported) {
            contentionReported = true;
            reportContention();
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      });
      preparations.push(second);
      await contentionObserved;
      assert.equal(activeDownloads, 1);
      releaseDownload();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(maximumActiveDownloads, 1);
      assert.equal(downloadCalls, 1);
      assert.deepEqual(firstResult.downloaded, [asset.path]);
      assert.deepEqual(secondResult.reused, [asset.path]);
      await embeddingModel.verifyEmbeddingModel({ manifest, modelDirectory: root });
    } finally {
      releaseDownload();
      await Promise.allSettled(preparations);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries lock acquisition when the previous owner releases during owner inspection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-lock-race-"));
    const modelDirectory = path.join(root, "model");
    const lockDirectory = `${path.resolve(modelDirectory)}.easy-code-model-install-lock`;
    const firstLock = await embeddingModel.acquireModelInstallLock(modelDirectory, {
      lockToken: "a".repeat(32),
    });
    let secondLock: { release(): Promise<void> } | undefined;
    let releaseTriggered = false;
    const racingFsp = new Proxy(fsPromises, {
      get(target, property) {
        if (property === "lstat") {
          return async (filePath: string) => {
            const metadata = await target.lstat(filePath);
            if (!releaseTriggered && path.resolve(filePath) === lockDirectory) {
              releaseTriggered = true;
              await firstLock.release();
            }
            return metadata;
          };
        }
        const operation = Reflect.get(target, property) as unknown;
        return typeof operation === "function" ? operation.bind(target) : operation;
      },
    });

    try {
      secondLock = await embeddingModel.acquireModelInstallLock(modelDirectory, {
        fsp: racingFsp,
        lockToken: "b".repeat(32),
        sleep: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      });
      assert.equal(releaseTriggered, true);
      await secondLock.release();
    } finally {
      if (secondLock) await secondLock.release().catch(() => {});
      await firstLock.release().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace an existing asset when a download fails exact hash verification", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-download-"));
    const destinationPath = path.join(root, "model.onnx");
    writeFileSync(destinationPath, "previous-good-file", "utf8");
    const expected = Buffer.from("expected");
    const corrupt = Buffer.from("corrupt!");
    try {
      await assert.rejects(
        embeddingModel.downloadHttpsFile(
          {
            url: "https://example.invalid/model.onnx",
            destinationPath,
            size: expected.length,
            sha256: sha256(expected),
          },
          {
            randomToken: () => "bad-download",
            openResponse: async () => response(corrupt),
          },
        ),
        /SHA256/iu,
      );
      assert.equal(readFileSync(destinationPath, "utf8"), "previous-good-file");
      assert.equal(readdirSync(root).some((name) => name.includes(".download-")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destroys a response with the wrong content length without replacing the target", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-length-"));
    const destinationPath = path.join(root, "model.onnx");
    const previousContents = "previous-good-file";
    const expected = Buffer.from("expected-download");
    writeFileSync(destinationPath, previousContents, "utf8");

    const mismatchedResponse = response(expected);
    mismatchedResponse.headers["content-length"] = String(expected.length + 1);
    const destroy = mismatchedResponse.destroy.bind(mismatchedResponse);
    let responseDestroyed = false;
    mismatchedResponse.destroy = ((error?: Error) => {
      responseDestroyed = true;
      return destroy(error);
    }) as typeof mismatchedResponse.destroy;

    try {
      await assert.rejects(
        embeddingModel.downloadHttpsFile(
          {
            url: "https://example.invalid/model.onnx",
            destinationPath,
            size: expected.length,
            sha256: sha256(expected),
          },
          {
            randomToken: () => "wrong-length",
            openResponse: async () => mismatchedResponse,
          },
        ),
        /declared .* bytes; expected/iu,
      );
      assert.equal(responseDestroyed, true);
      assert.equal(readFileSync(destinationPath, "utf8"), previousContents);
      assert.equal(readdirSync(root).some((name) => name.includes(".download-")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destroys a slow response when the absolute download deadline expires", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-deadline-"));
    const destinationPath = path.join(root, "model.onnx");
    const expected = Buffer.from("eventual-download");
    const slowResponse = Object.assign(
      new Readable({ read() {} }),
      { headers: { "content-length": String(expected.length) } },
    );
    const destroy = slowResponse.destroy.bind(slowResponse);
    let responseDestroyed = false;
    slowResponse.destroy = ((error?: Error) => {
      responseDestroyed = true;
      return destroy(error);
    }) as typeof slowResponse.destroy;

    try {
      await assert.rejects(
        embeddingModel.downloadHttpsFile(
          {
            url: "https://example.invalid/model.onnx",
            destinationPath,
            size: expected.length,
            sha256: sha256(expected),
          },
          {
            deadlineMs: 10,
            idleTimeoutMs: 1_000,
            randomToken: () => "deadline",
            openResponse: async () => slowResponse,
          },
        ),
        /absolute deadline/iu,
      );
      assert.equal(responseDestroyed, true);
      assert.equal(readdirSync(root).some((name) => name.includes(".download-")), false);
    } finally {
      slowResponse.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates Orama, tokenizer, and ONNX inference through injectable runtimes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-runtime-"));
    let released = false;
    let loadedModelPath = "";
    class FakeTokenizer {
      constructor(_tokenizer: object, _config: object) {}

      encode(): {
        ids: number[];
        attention_mask: number[];
        token_type_ids: number[];
      } {
        return {
          ids: [101, 2023, 102],
          attention_mask: [1, 1, 1],
          token_type_ids: [0, 0, 0],
        };
      }
    }
    class FakeTensor {
      constructor(
        readonly type: string,
        readonly data: BigInt64Array,
        readonly dims: number[],
      ) {}
    }
    try {
      await postinstall.validateEmbeddingStack(
        {
          modelDirectory: root,
          manifest: { dimension: 384, maxSequenceLength: 128 },
        },
        {
          readFile: async () => "{}",
          loadTokenizer: async () => ({ Tokenizer: FakeTokenizer }),
          loadOnnx: async () => ({
            default: {
              Tensor: FakeTensor,
              InferenceSession: {
                create: async (modelPath: string) => {
                  loadedModelPath = modelPath;
                  return {
                    inputNames: ["input_ids", "attention_mask", "token_type_ids"],
                    outputNames: ["last_hidden_state"],
                    run: async (feeds: Record<string, FakeTensor>) => {
                      assert.deepEqual(Object.keys(feeds).sort(), [
                        "attention_mask",
                        "input_ids",
                        "token_type_ids",
                      ]);
                      return {
                        last_hidden_state: {
                          dims: [1, 3, 384],
                          data: new Float32Array(3 * 384),
                        },
                      };
                    },
                    release: async () => {
                      released = true;
                    },
                  };
                },
              },
            },
          }),
        },
      );
      assert.equal(
        loadedModelPath,
        path.join(root, "onnx", "model_quantized.onnx"),
      );
      assert.equal(released, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps Orama vectors enabled during its install self-test", async () => {
    interface InstallCheckDocument {
      readonly id: string;
      readonly workspaceId: string;
      readonly status: string;
      readonly confidence: number;
      readonly embedding: readonly number[];
    }

    interface InstallCheckSearchOptions {
      readonly includeVectors?: boolean;
      readonly limit?: number;
      readonly where?: {
        readonly workspaceId?: { readonly eq?: string };
        readonly status?: { readonly eq?: string };
        readonly confidence?: { readonly gte?: number };
      };
    }

    const documents = new Map<string, InstallCheckDocument>();
    const insertedDocuments: InstallCheckDocument[] = [];
    const searchOptions: InstallCheckSearchOptions[] = [];
    const events: string[] = [];
    let insertBatchSize: number | undefined;
    await postinstall.validateOrama({
      loadOrama: async () => ({
        create: async () => ({}),
        insertMultiple: async (
          _database: unknown,
          batch: readonly InstallCheckDocument[],
          batchSize?: number,
        ) => {
          events.push("insertMultiple");
          insertBatchSize = batchSize;
          for (const document of batch) {
            documents.set(document.id, document);
            insertedDocuments.push(document);
          }
          return batch.map((document) => document.id);
        },
        search: async (_database: unknown, options: InstallCheckSearchOptions) => {
          events.push("search");
          searchOptions.push(options);
          const workspaceId = options.where?.workspaceId?.eq;
          const status = options.where?.status?.eq;
          const minimumConfidence = options.where?.confidence?.gte;
          const matches = [...documents.values()].filter(
            (document) =>
              (workspaceId === undefined || document.workspaceId === workspaceId) &&
              (status === undefined || document.status === status) &&
              (minimumConfidence === undefined || document.confidence >= minimumConfidence),
          );
          return {
            hits: matches.slice(0, options.limit).map((document) => ({
              id: document.id,
              score: document.embedding[0] ?? 0,
              document,
            })),
          };
        },
        remove: async (_database: unknown, id: string) => {
          events.push(`remove:${id}`);
          return documents.delete(id);
        },
      }),
    });

    assert.equal(insertBatchSize, 100);
    assert.deepEqual(insertedDocuments.map((document) => document.id), [
      "easy_code_vector_a",
      "easy_code_vector_b",
      "easy_code_vector_c",
      "easy_code_vector_d",
    ]);
    assert.deepEqual(events, [
      "insertMultiple",
      "search",
      "search",
      "remove:easy_code_vector_a",
      "search",
    ]);
    assert.equal(searchOptions.length, 3);
    const firstSearch = searchOptions[0];
    assert.ok(firstSearch);
    assert.deepEqual(searchOptions[1], firstSearch);
    assert.deepEqual(searchOptions[2], firstSearch);
    for (const options of searchOptions) {
      assert.equal(options.includeVectors, true);
      assert.equal(options.where?.workspaceId?.eq, "install_check");
      assert.equal(options.where?.status?.eq, "active");
      assert.equal(typeof options.where?.confidence?.gte, "number");
    }
  });
});

interface ProviderFakeTensor {
  readonly type: "int64";
  readonly data: BigInt64Array;
  readonly dims: readonly number[];
}

function writeProviderFixture(manifest: unknown = PROVIDER_MODEL_MANIFEST): string {
  const directory = mkdtempSync(path.join(tmpdir(), "easy-code-embedding-provider-"));
  mkdirSync(path.join(directory, "onnx"));
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    path.join(directory, "config.json"),
    JSON.stringify({ model_type: "bert", hidden_size: 384, pad_token_id: 0 }),
  );
  writeFileSync(path.join(directory, "tokenizer.json"), "{}");
  writeFileSync(
    path.join(directory, "tokenizer_config.json"),
    JSON.stringify({ pad_token: "<pad>" }),
  );
  writeFileSync(path.join(directory, "special_tokens_map.json"), "{}");
  writeFileSync(path.join(directory, "onnx", "model_quantized.onnx"), "fixture");
  return directory;
}

function providerTokenizer(): EmbeddingTokenizer {
  return {
    encode(text) {
      if (text === "short") {
        return {
          ids: [101, 11, 102],
          attention_mask: [1, 1, 1],
          token_type_ids: [0, 0, 0],
        };
      }
      if (text === "truncate") {
        const content = Array.from({ length: 130 }, (_, index) => 1_000 + index);
        return {
          ids: [101, ...content, 102],
          attention_mask: new Array(content.length + 2).fill(1),
          token_type_ids: new Array(content.length + 2).fill(0),
        };
      }
      return {
        ids: [101, 21, 22, 102],
        attention_mask: [1, 1, 1, 1],
        token_type_ids: [0, 0, 0, 0],
      };
    },
    // Deliberately differs from config.json's pad_token_id to match the pinned
    // multilingual tokenizer conversion used in production.
    token_to_id: (token) => token === "<pad>" ? 1 : undefined,
  };
}

function providerDependencies(
  session: EmbeddingSession,
  overrides: Partial<EmbeddingModelDependencies> = {},
): Partial<EmbeddingModelDependencies> {
  return {
    verifyFile: async () => undefined,
    createTokenizer: async () => providerTokenizer(),
    createSession: async () => session,
    createInt64Tensor: (data, dims): ProviderFakeTensor => ({
      type: "int64",
      data,
      dims,
    }),
    ...overrides,
  };
}

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

describe("local embedding provider", () => {
  it("pads, truncates, masked-mean pools, and L2 normalizes fake ONNX output", async () => {
    const directory = writeProviderFixture();
    const captured: ProviderFakeTensor[] = [];
    const session: EmbeddingSession = {
      inputNames: ["input_ids", "attention_mask", "token_type_ids"],
      outputNames: ["last_hidden_state"],
      async run(feeds) {
        const ids = feeds.input_ids as ProviderFakeTensor;
        captured.push(ids);
        const [batchSize, sequenceLength] = ids.dims as readonly [number, number];
        const values = new Float32Array(
          batchSize * sequenceLength * EMBEDDING_DIMENSION,
        );
        for (let batch = 0; batch < batchSize; batch += 1) {
          for (let token = 0; token < sequenceLength; token += 1) {
            const offset = (batch * sequenceLength + token) * EMBEDDING_DIMENSION;
            if (batch === 0) {
              if (token < 2) values[offset] = 1;
              if (token === 2) values[offset + 1] = 2;
              if (token === 3) {
                values[offset] = 1_000;
                values[offset + 1] = 1_000;
              }
            } else {
              values[offset] = 3;
            }
          }
        }
        return {
          last_hidden_state: {
            type: "float32",
            dims: [batchSize, sequenceLength, EMBEDDING_DIMENSION],
            data: values,
          },
        };
      },
    };
    try {
      const provider = new LocalEmbeddingModel({
        modelDirectory: directory,
        dependencies: providerDependencies(session),
      });
      const vectors = await provider.embed(["short", "long"]);
      assert.deepEqual(captured[0]?.dims, [2, 4]);
      assert.deepEqual(
        Array.from(captured[0]!.data, Number),
        [101, 11, 102, 1, 101, 21, 22, 102],
      );
      assert.ok(Math.abs((vectors[0]?.[0] ?? 0) - Math.SQRT1_2) < 1e-6);
      assert.ok(Math.abs((vectors[0]?.[1] ?? 0) - Math.SQRT1_2) < 1e-6);
      assert.ok(Math.abs((vectors[1]?.[0] ?? 0) - 1) < 1e-6);
      assert.ok(Math.abs(vectorNorm(vectors[0]!) - 1) < 1e-6);

      await provider.embed(["truncate"]);
      assert.deepEqual(captured[1]?.dims, [1, EMBEDDING_MAX_SEQUENCE_LENGTH]);
      assert.equal(captured[1]?.data[0], 101n);
      assert.equal(captured[1]?.data[EMBEDDING_MAX_SEQUENCE_LENGTH - 1], 102n);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a local manifest that does not identify the pinned artifacts", async () => {
    const directory = writeProviderFixture({
      ...PROVIDER_MODEL_MANIFEST,
      revision: "main",
    });
    let sessionCreations = 0;
    const session: EmbeddingSession = {
      inputNames: ["input_ids", "attention_mask", "token_type_ids"],
      outputNames: ["last_hidden_state"],
      async run() {
        throw new Error("unreachable");
      },
    };
    try {
      const provider = new LocalEmbeddingModel({
        modelDirectory: directory,
        dependencies: providerDependencies(session, {
          createSession: async () => {
            sessionCreations += 1;
            return session;
          },
        }),
      });
      await assert.rejects(() => provider.embed(["short"]), /pinned model/iu);
      assert.equal(sessionCreations, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares one lazy tokenizer and ONNX session load across concurrent calls", async () => {
    const directory = writeProviderFixture();
    let tokenizerCreations = 0;
    let sessionCreations = 0;
    let runs = 0;
    const session: EmbeddingSession = {
      inputNames: ["input_ids", "attention_mask", "token_type_ids"],
      outputNames: ["last_hidden_state"],
      async run(feeds) {
        runs += 1;
        const input = feeds.input_ids as ProviderFakeTensor;
        const [batchSize, sequenceLength] = input.dims as readonly [number, number];
        const values = new Float32Array(
          batchSize * sequenceLength * EMBEDDING_DIMENSION,
        );
        for (let batch = 0; batch < batchSize; batch += 1) {
          for (let token = 0; token < sequenceLength; token += 1) {
            values[(batch * sequenceLength + token) * EMBEDDING_DIMENSION] = 1;
          }
        }
        return {
          last_hidden_state: {
            type: "float32",
            dims: [batchSize, sequenceLength, EMBEDDING_DIMENSION],
            data: values,
          },
        };
      },
    };
    try {
      const provider = new LocalEmbeddingModel({
        modelDirectory: directory,
        dependencies: providerDependencies(session, {
          createTokenizer: async () => {
            tokenizerCreations += 1;
            await Promise.resolve();
            return providerTokenizer();
          },
          createSession: async () => {
            sessionCreations += 1;
            await Promise.resolve();
            return session;
          },
        }),
      });
      const results = await Promise.all([
        provider.embed(["short"]),
        provider.embed(["long"]),
        provider.embed(["short", "long"]),
      ]);
      assert.equal(tokenizerCreations, 1);
      assert.equal(sessionCreations, 1);
      assert.equal(runs, 3);
      assert.deepEqual(results.map((result) => result.length), [1, 1, 2]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
