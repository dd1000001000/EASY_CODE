import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveEasyCodePaths } from "../config/defaults.js";
import type { EmbeddingProvider } from "./vector-index.js";

export const EMBEDDING_MODEL_ID =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_MODEL_REVISION =
  "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const EMBEDDING_DIMENSION = 384;
export const EMBEDDING_MAX_SEQUENCE_LENGTH = 128;
export const EMBEDDING_POOLING = "masked-mean";
export const EMBEDDING_VERSION = 1;
export const EMBEDDING_MODEL_DIRECTORY_NAME =
  "paraphrase-multilingual-MiniLM-L12-v2";

export interface EmbeddingModelFileManifest {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EmbeddingModelManifest {
  readonly model: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxSequenceLength: number;
  readonly pooling: string;
  readonly normalized: boolean;
  readonly files: readonly EmbeddingModelFileManifest[];
}

export const EMBEDDING_MODEL_MANIFEST = {
  model: EMBEDDING_MODEL_ID,
  revision: EMBEDDING_MODEL_REVISION,
  dimension: EMBEDDING_DIMENSION,
  maxSequenceLength: EMBEDDING_MAX_SEQUENCE_LENGTH,
  pooling: EMBEDDING_POOLING,
  normalized: true,
  files: [
    {
      path: "config.json",
      size: 673,
      sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
    },
    {
      path: "special_tokens_map.json",
      size: 280,
      sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    },
    {
      path: "tokenizer.json",
      size: 17_082_913,
      sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
    },
    {
      path: "tokenizer_config.json",
      size: 496,
      sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
    },
    {
      path: "onnx/model_quantized.onnx",
      size: 118_308_126,
      sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
    },
  ],
} as const satisfies EmbeddingModelManifest;

interface TokenizerEncoding {
  readonly ids: number[];
  readonly attention_mask: number[];
  readonly token_type_ids?: number[];
}

export interface EmbeddingTokenizer {
  encode(
    text: string,
    options: { readonly return_token_type_ids: true },
  ): TokenizerEncoding;
  token_to_id?(token: string): number | undefined;
}

export interface EmbeddingTensor {
  readonly type: string;
  readonly dims: readonly number[];
  readonly data: unknown;
}

export interface EmbeddingSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, EmbeddingTensor>>>;
}

export interface EmbeddingModelDependencies {
  readTextFile(filename: string): Promise<string>;
  verifyFile(
    filename: string,
    expected: EmbeddingModelFileManifest,
  ): Promise<void>;
  createTokenizer(
    tokenizerJson: Readonly<Record<string, unknown>>,
    tokenizerConfig: Readonly<Record<string, unknown>>,
  ): Promise<EmbeddingTokenizer>;
  createSession(modelPath: string): Promise<EmbeddingSession>;
  createInt64Tensor(data: BigInt64Array, dims: readonly number[]): unknown;
}

export interface LocalEmbeddingModelOptions {
  /** Cache root from EasyCodeConfig; the model subdirectory is appended automatically. */
  readonly cacheDirectory?: string;
  readonly modelDirectory?: string;
  /** Dependency seams for deterministic, network-free tests. */
  readonly dependencies?: Partial<EmbeddingModelDependencies>;
}

interface LoadedEmbeddingModel {
  readonly tokenizer: EmbeddingTokenizer;
  readonly session: EmbeddingSession;
  readonly padTokenId: number;
}

interface PreparedEncoding {
  readonly ids: readonly number[];
  readonly attentionMask: readonly number[];
  readonly tokenTypeIds: readonly number[];
}

interface OrtModule {
  readonly InferenceSession: {
    create(
      modelPath: string,
      options?: Readonly<Record<string, unknown>>,
    ): Promise<EmbeddingSession>;
  };
  readonly Tensor: new (
    type: "int64",
    data: BigInt64Array,
    dims: readonly number[],
  ) => unknown;
}

const MANIFEST_FILENAME = "manifest.json";
const MODEL_FILENAME = "onnx/model_quantized.onnx";
const TOKENIZER_FILENAME = "tokenizer.json";
const TOKENIZER_CONFIG_FILENAME = "tokenizer_config.json";
const CONFIG_FILENAME = "config.json";
const MAX_MANIFEST_CHARS = 64_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_INPUTS = ["input_ids", "attention_mask", "token_type_ids"] as const;
const REQUIRED_OUTPUT = "last_hidden_state";

export function resolveDefaultEmbeddingModelDirectory(
  cacheDirectory = resolveEasyCodePaths().cacheDir,
): string {
  return path.join(
    path.resolve(cacheDirectory),
    "models",
    EMBEDDING_MODEL_DIRECTORY_NAME,
  );
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseJsonObject(text: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return record(parsed, label);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected schema`);
  }
}

function parseManifest(text: string): EmbeddingModelManifest {
  if (text.length > MAX_MANIFEST_CHARS) {
    throw new Error("Embedding model manifest is too large");
  }
  const value = parseJsonObject(text, "Embedding model manifest");
  assertExactKeys(
    value,
    [
      "model",
      "revision",
      "dimension",
      "maxSequenceLength",
      "pooling",
      "normalized",
      "files",
    ],
    "Embedding model manifest",
  );
  if (!Array.isArray(value.files)) {
    throw new Error("Embedding model manifest files must be an array");
  }
  if (
    typeof value.model !== "string" ||
    typeof value.revision !== "string" ||
    !Number.isSafeInteger(value.dimension) ||
    !Number.isSafeInteger(value.maxSequenceLength) ||
    typeof value.pooling !== "string" ||
    typeof value.normalized !== "boolean"
  ) {
    throw new Error("Embedding model manifest has invalid field types");
  }

  const files = value.files.map((item, index): EmbeddingModelFileManifest => {
    const file = record(item, `Embedding model manifest file ${index}`);
    assertExactKeys(
      file,
      ["path", "size", "sha256"],
      `Embedding model manifest file ${index}`,
    );
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.includes("\\") ||
      path.posix.normalize(file.path) !== file.path ||
      file.path.startsWith("/") ||
      file.path.startsWith("../")
    ) {
      throw new Error(`Embedding model manifest file ${index} has an unsafe path`);
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) <= 0) {
      throw new Error(`Embedding model manifest file ${index} has an invalid size`);
    }
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Embedding model manifest file ${index} has an invalid SHA-256`);
    }
    return {
      path: file.path,
      size: file.size as number,
      sha256: file.sha256,
    };
  });

  const manifest: EmbeddingModelManifest = {
    model: value.model,
    revision: value.revision,
    dimension: value.dimension as number,
    maxSequenceLength: value.maxSequenceLength as number,
    pooling: value.pooling,
    normalized: value.normalized,
    files,
  };
  validatePinnedManifest(manifest);
  return manifest;
}

function validatePinnedManifest(manifest: EmbeddingModelManifest): void {
  const expected = EMBEDDING_MODEL_MANIFEST;
  if (
    manifest.model !== expected.model ||
    manifest.revision !== expected.revision ||
    manifest.dimension !== expected.dimension ||
    manifest.maxSequenceLength !== expected.maxSequenceLength ||
    manifest.pooling !== expected.pooling ||
    manifest.normalized !== expected.normalized
  ) {
    throw new Error("Embedding model manifest does not identify the pinned model");
  }
  if (manifest.files.length !== expected.files.length) {
    throw new Error("Embedding model manifest does not contain the pinned file set");
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  if (files.size !== manifest.files.length) {
    throw new Error("Embedding model manifest contains duplicate file paths");
  }
  for (const wanted of expected.files) {
    const actual = files.get(wanted.path);
    if (
      !actual ||
      actual.size !== wanted.size ||
      actual.sha256 !== wanted.sha256
    ) {
      throw new Error(`Embedding model manifest does not match ${wanted.path}`);
    }
  }
}

function resolveContainedFile(modelDirectory: string, relativePath: string): string {
  const candidate = path.resolve(modelDirectory, ...relativePath.split("/"));
  const relative = path.relative(modelDirectory, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Embedding model file path escapes the model directory: ${relativePath}`);
  }
  return candidate;
}

async function verifyFileIntegrity(
  filename: string,
  expected: EmbeddingModelFileManifest,
): Promise<void> {
  const info = await lstat(filename).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Embedding model file is missing or unsafe: ${expected.path}`);
  }
  if (info.size !== expected.size) {
    throw new Error(`Embedding model file has the wrong size: ${expected.path}`);
  }
  const hash = createHash("sha256");
  const stream = createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== expected.sha256) {
    throw new Error(`Embedding model file failed SHA-256 verification: ${expected.path}`);
  }
}

function createDefaultDependencies(): EmbeddingModelDependencies {
  let ort: OrtModule | undefined;
  const loadOrt = (): OrtModule => {
    if (!ort) {
      const require = createRequire(import.meta.url);
      ort = require("onnxruntime-node") as OrtModule;
    }
    return ort;
  };
  return {
    readTextFile: (filename) => readFile(filename, "utf8"),
    verifyFile: verifyFileIntegrity,
    createTokenizer: async (tokenizerJson, tokenizerConfig) => {
      const { Tokenizer } = await import("@huggingface/tokenizers");
      return new Tokenizer(tokenizerJson, tokenizerConfig);
    },
    createSession: (modelPath) =>
      loadOrt().InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      }),
    createInt64Tensor: (data, dims) =>
      new (loadOrt().Tensor)("int64", data, dims),
  };
}

function safeIntegerArray(
  value: unknown,
  label: string,
  expectedLength?: number,
): number[] {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new Error(`${label} has an invalid length`);
  }
  const result = value.map((item) => Number(item));
  if (result.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`${label} contains an invalid token value`);
  }
  return result;
}

function prepareEncoding(tokenizer: EmbeddingTokenizer, text: string): PreparedEncoding {
  const encoded = tokenizer.encode(text, { return_token_type_ids: true });
  let ids = safeIntegerArray(encoded.ids, "Tokenizer input_ids");
  let attentionMask = safeIntegerArray(
    encoded.attention_mask,
    "Tokenizer attention_mask",
    ids.length,
  );
  let tokenTypeIds = encoded.token_type_ids === undefined
    ? new Array(ids.length).fill(0)
    : safeIntegerArray(encoded.token_type_ids, "Tokenizer token_type_ids", ids.length);
  if (ids.length < 2) {
    throw new Error("Tokenizer did not add the required boundary tokens");
  }
  if (attentionMask.some((value) => value !== 0 && value !== 1)) {
    throw new Error("Tokenizer attention_mask must contain only zeroes and ones");
  }

  if (ids.length > EMBEDDING_MAX_SEQUENCE_LENGTH) {
    const finalIndex = ids.length - 1;
    ids = [
      ...ids.slice(0, EMBEDDING_MAX_SEQUENCE_LENGTH - 1),
      ids[finalIndex]!,
    ];
    attentionMask = [
      ...attentionMask.slice(0, EMBEDDING_MAX_SEQUENCE_LENGTH - 1),
      attentionMask[finalIndex]!,
    ];
    tokenTypeIds = [
      ...tokenTypeIds.slice(0, EMBEDDING_MAX_SEQUENCE_LENGTH - 1),
      tokenTypeIds[finalIndex]!,
    ];
  }
  return { ids, attentionMask, tokenTypeIds };
}

function requireModelConfiguration(config: Readonly<Record<string, unknown>>): number {
  if (
    config.model_type !== "bert" ||
    config.hidden_size !== EMBEDDING_DIMENSION ||
    !Number.isSafeInteger(config.pad_token_id) ||
    (config.pad_token_id as number) < 0
  ) {
    throw new Error("Embedding model config.json is incompatible with the pinned model");
  }
  return config.pad_token_id as number;
}

function validateSession(session: EmbeddingSession): void {
  for (const input of REQUIRED_INPUTS) {
    if (!session.inputNames.includes(input)) {
      throw new Error(`Embedding ONNX model is missing input ${input}`);
    }
  }
  if (!session.outputNames.includes(REQUIRED_OUTPUT)) {
    throw new Error(`Embedding ONNX model is missing output ${REQUIRED_OUTPUT}`);
  }
}

function poolAndNormalize(
  output: EmbeddingTensor | undefined,
  attentionMasks: readonly (readonly number[])[],
  sequenceLength: number,
): Float32Array[] {
  const batchSize = attentionMasks.length;
  const expectedLength = batchSize * sequenceLength * EMBEDDING_DIMENSION;
  if (
    !output ||
    output.type !== "float32" ||
    !(output.data instanceof Float32Array) ||
    output.dims.length !== 3 ||
    output.dims[0] !== batchSize ||
    output.dims[1] !== sequenceLength ||
    output.dims[2] !== EMBEDDING_DIMENSION ||
    output.data.length !== expectedLength
  ) {
    throw new Error("Embedding ONNX model returned an invalid last_hidden_state tensor");
  }

  const embeddings: Float32Array[] = [];
  for (let batch = 0; batch < batchSize; batch += 1) {
    const pooled = new Float64Array(EMBEDDING_DIMENSION);
    let includedTokens = 0;
    for (let token = 0; token < sequenceLength; token += 1) {
      if (attentionMasks[batch]?.[token] !== 1) continue;
      includedTokens += 1;
      const offset = (batch * sequenceLength + token) * EMBEDDING_DIMENSION;
      for (let dimension = 0; dimension < EMBEDDING_DIMENSION; dimension += 1) {
        const value = output.data[offset + dimension]!;
        if (!Number.isFinite(value)) {
          throw new Error("Embedding ONNX model returned a non-finite value");
        }
        pooled[dimension] = pooled[dimension]! + value;
      }
    }
    if (includedTokens === 0) {
      throw new Error("Embedding tokenizer produced an empty attention mask");
    }

    let squaredNorm = 0;
    for (let dimension = 0; dimension < EMBEDDING_DIMENSION; dimension += 1) {
      pooled[dimension] = pooled[dimension]! / includedTokens;
      squaredNorm += pooled[dimension]! * pooled[dimension]!;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
      throw new Error("Embedding ONNX model returned a zero-norm vector");
    }
    const normalized = new Float32Array(EMBEDDING_DIMENSION);
    for (let dimension = 0; dimension < EMBEDDING_DIMENSION; dimension += 1) {
      normalized[dimension] = pooled[dimension]! / norm;
    }
    embeddings.push(normalized);
  }
  return embeddings;
}

export class LocalEmbeddingModel implements EmbeddingProvider {
  readonly dimension = EMBEDDING_DIMENSION;
  readonly model = EMBEDDING_MODEL_ID;
  readonly revision = EMBEDDING_MODEL_REVISION;
  readonly pooling = EMBEDDING_POOLING;
  readonly version = EMBEDDING_VERSION;

  private readonly modelDirectory: string;
  private readonly dependencies: EmbeddingModelDependencies;
  private loading: Promise<LoadedEmbeddingModel> | undefined;

  constructor(options: LocalEmbeddingModelOptions = {}) {
    if (options.cacheDirectory && options.modelDirectory) {
      throw new Error("Specify either cacheDirectory or modelDirectory, not both");
    }
    this.modelDirectory = path.resolve(
      options.modelDirectory ??
        resolveDefaultEmbeddingModelDirectory(options.cacheDirectory),
    );
    this.dependencies = {
      ...createDefaultDependencies(),
      ...options.dependencies,
    };
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
      throw new Error("Embedding input must be an array of strings");
    }
    if (texts.length === 0) return [];
    const loaded = await this.loadOnce();
    const encodings = texts.map((text) => prepareEncoding(loaded.tokenizer, text));
    const sequenceLength = Math.max(...encodings.map((encoding) => encoding.ids.length));
    const elementCount = texts.length * sequenceLength;
    const inputIds = new BigInt64Array(elementCount);
    inputIds.fill(BigInt(loaded.padTokenId));
    const attentionMask = new BigInt64Array(elementCount);
    const tokenTypeIds = new BigInt64Array(elementCount);

    for (let batch = 0; batch < encodings.length; batch += 1) {
      const encoding = encodings[batch]!;
      const offset = batch * sequenceLength;
      for (let token = 0; token < encoding.ids.length; token += 1) {
        inputIds[offset + token] = BigInt(encoding.ids[token]!);
        attentionMask[offset + token] = BigInt(encoding.attentionMask[token]!);
        tokenTypeIds[offset + token] = BigInt(encoding.tokenTypeIds[token]!);
      }
    }

    const dims = [texts.length, sequenceLength] as const;
    const outputs = await loaded.session.run({
      input_ids: this.dependencies.createInt64Tensor(inputIds, dims),
      attention_mask: this.dependencies.createInt64Tensor(attentionMask, dims),
      token_type_ids: this.dependencies.createInt64Tensor(tokenTypeIds, dims),
    });
    const paddedMasks = encodings.map((encoding) => [
      ...encoding.attentionMask,
      ...new Array(sequenceLength - encoding.attentionMask.length).fill(0),
    ]);
    return poolAndNormalize(outputs[REQUIRED_OUTPUT], paddedMasks, sequenceLength);
  }

  private loadOnce(): Promise<LoadedEmbeddingModel> {
    if (this.loading) return this.loading;
    const pending = this.load();
    this.loading = pending;
    void pending.catch(() => {
      if (this.loading === pending) this.loading = undefined;
    });
    return pending;
  }

  private async load(): Promise<LoadedEmbeddingModel> {
    const manifestText = await this.dependencies.readTextFile(
      path.join(this.modelDirectory, MANIFEST_FILENAME),
    );
    const manifest = parseManifest(manifestText);
    for (const file of manifest.files) {
      await this.dependencies.verifyFile(
        resolveContainedFile(this.modelDirectory, file.path),
        file,
      );
    }

    const [tokenizerText, tokenizerConfigText, configText] = await Promise.all([
      this.dependencies.readTextFile(
        resolveContainedFile(this.modelDirectory, TOKENIZER_FILENAME),
      ),
      this.dependencies.readTextFile(
        resolveContainedFile(this.modelDirectory, TOKENIZER_CONFIG_FILENAME),
      ),
      this.dependencies.readTextFile(
        resolveContainedFile(this.modelDirectory, CONFIG_FILENAME),
      ),
    ]);
    const tokenizerJson = parseJsonObject(tokenizerText, TOKENIZER_FILENAME);
    const tokenizerConfig = parseJsonObject(
      tokenizerConfigText,
      TOKENIZER_CONFIG_FILENAME,
    );
    const config = parseJsonObject(configText, CONFIG_FILENAME);
    const configuredPadTokenId = requireModelConfiguration(config);
    const tokenizer = await this.dependencies.createTokenizer(
      tokenizerJson,
      tokenizerConfig,
    );
    let padTokenId = configuredPadTokenId;
    if (typeof tokenizer.token_to_id === "function") {
      const padToken = typeof tokenizerConfig.pad_token === "string"
        ? tokenizerConfig.pad_token
        : null;
      if (padToken) {
        const tokenizerPadTokenId = tokenizer.token_to_id(padToken);
        if (
          !Number.isSafeInteger(tokenizerPadTokenId) ||
          (tokenizerPadTokenId as number) < 0
        ) {
          throw new Error("Embedding tokenizer does not contain its configured pad token");
        }
        // The pinned converted model's config.json reports 0 while its
        // SentencePiece tokenizer correctly maps <pad> to 1. Padded positions
        // are attention-masked, and tokenizer metadata is authoritative for
        // constructing token IDs.
        padTokenId = tokenizerPadTokenId as number;
      }
    }
    const session = await this.dependencies.createSession(
      resolveContainedFile(this.modelDirectory, MODEL_FILENAME),
    );
    validateSession(session);
    return { tokenizer, session, padTokenId };
  }
}
