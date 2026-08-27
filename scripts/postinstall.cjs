"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { prepareEmbeddingModel } = require("./embedding-model.cjs");
const { installBundledVsCodeExtension } = require("./install-vscode-extension.cjs");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function importedDefault(value) {
  return value && typeof value === "object" && "default" in value
    ? value.default
    : value;
}

function assertIntegerArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !Number.isSafeInteger(item) || item < 0)
  ) {
    throw new Error(`Embedding tokenizer returned invalid ${label}`);
  }
  return value;
}

async function validateOrama(options = {}) {
  const loadOrama = options.loadOrama || (() => import("@orama/orama"));
  const orama = await loadOrama();
  for (const name of ["create", "insertMultiple", "search", "remove"]) {
    if (typeof orama[name] !== "function") {
      throw new Error(`@orama/orama did not export ${name}`);
    }
  }

  const database = await orama.create({
    schema: {
      workspaceId: "enum",
      status: "enum",
      confidence: "number",
      embedding: "vector[2]",
    },
  });
  await orama.insertMultiple(database, [
    {
      id: "easy_code_vector_a",
      workspaceId: "install_check",
      status: "active",
      confidence: 0.95,
      embedding: [0.9, 0.1],
    },
    {
      id: "easy_code_vector_b",
      workspaceId: "other_workspace",
      status: "active",
      confidence: 0.95,
      embedding: [1, 0],
    },
    {
      id: "easy_code_vector_c",
      workspaceId: "install_check",
      status: "active",
      confidence: 0.2,
      embedding: [1, 0],
    },
    {
      id: "easy_code_vector_d",
      workspaceId: "install_check",
      status: "inactive",
      confidence: 0.95,
      embedding: [1, 0],
    },
  ], 100);
  const searchOptions = {
    mode: "vector",
    vector: { property: "embedding", value: [1, 0] },
    where: {
      workspaceId: { eq: "install_check" },
      status: { eq: "active" },
      confidence: { gte: 0.8 },
    },
    similarity: 0,
    offset: 0,
    limit: 1,
    // Orama 2.1.1 mutates its document store when this is false. Keep vectors
    // internally and discard them at EASY CODE's API boundary instead.
    includeVectors: true,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await orama.search(database, searchOptions);
    if (
      !result ||
      !Array.isArray(result.hits) ||
      result.hits.length !== 1 ||
      result.hits[0].id !== "easy_code_vector_a" ||
      !Number.isFinite(result.hits[0].score)
    ) {
      throw new Error("@orama/orama repeated vector search self-test returned an unexpected result");
    }
  }
  if (await orama.remove(database, "easy_code_vector_a") !== true) {
    throw new Error("@orama/orama vector removal self-test failed");
  }
  const removedResult = await orama.search(database, searchOptions);
  if (!removedResult || !Array.isArray(removedResult.hits) || removedResult.hits.length !== 0) {
    throw new Error("@orama/orama returned a removed vector during its self-test");
  }
}

async function validateTokenizerAndOnnx(modelResult, options = {}) {
  if (
    !modelResult ||
    typeof modelResult.modelDirectory !== "string" ||
    !modelResult.manifest ||
    !Number.isInteger(modelResult.manifest.dimension) ||
    !Number.isInteger(modelResult.manifest.maxSequenceLength)
  ) {
    throw new Error("Embedding model preparation returned invalid metadata");
  }

  const readFile = options.readFile || fs.promises.readFile;
  const loadTokenizer = options.loadTokenizer || (() => import("@huggingface/tokenizers"));
  const loadOnnx = options.loadOnnx || (() => import("onnxruntime-node"));
  const [tokenizersModule, onnxModule, tokenizerSource, tokenizerConfigSource] =
    await Promise.all([
      loadTokenizer(),
      loadOnnx(),
      readFile(path.join(modelResult.modelDirectory, "tokenizer.json"), "utf8"),
      readFile(path.join(modelResult.modelDirectory, "tokenizer_config.json"), "utf8"),
    ]);
  const tokenizersDefault = importedDefault(tokenizersModule);
  const Tokenizer = tokenizersModule.Tokenizer || tokenizersDefault?.Tokenizer;
  if (typeof Tokenizer !== "function") {
    throw new Error("@huggingface/tokenizers did not export Tokenizer");
  }
  const ort = importedDefault(onnxModule);
  if (
    !ort ||
    !ort.InferenceSession ||
    typeof ort.InferenceSession.create !== "function" ||
    typeof ort.Tensor !== "function"
  ) {
    throw new Error("onnxruntime-node did not expose its inference API");
  }

  let tokenizerJson;
  let tokenizerConfig;
  try {
    tokenizerJson = JSON.parse(String(tokenizerSource));
    tokenizerConfig = JSON.parse(String(tokenizerConfigSource));
  } catch (error) {
    throw new Error(`Embedding tokenizer configuration is invalid JSON: ${errorMessage(error)}`);
  }
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const encoded = tokenizer.encode(
    "EASY CODE remembers stable project conventions.",
    { return_token_type_ids: true },
  );
  const maximum = modelResult.manifest.maxSequenceLength;
  const ids = assertIntegerArray(encoded && encoded.ids, "input IDs").slice(0, maximum);
  const attention = assertIntegerArray(
    encoded && encoded.attention_mask,
    "attention mask",
  ).slice(0, ids.length);
  if (attention.length !== ids.length) {
    throw new Error("Embedding tokenizer returned mismatched input and attention lengths");
  }
  const tokenTypes = Array.isArray(encoded.token_type_ids)
    ? assertIntegerArray(encoded.token_type_ids, "token type IDs").slice(0, ids.length)
    : new Array(ids.length).fill(0);
  if (tokenTypes.length !== ids.length) {
    throw new Error("Embedding tokenizer returned mismatched token type IDs");
  }

  const dimensions = [1, ids.length];
  const tensor = (values) => new ort.Tensor(
    "int64",
    BigInt64Array.from(values, (value) => BigInt(value)),
    dimensions,
  );
  let session;
  try {
    session = await ort.InferenceSession.create(
      path.join(modelResult.modelDirectory, "onnx", "model_quantized.onnx"),
      { executionProviders: ["cpu"] },
    );
    const inputNames = Array.isArray(session.inputNames)
      ? session.inputNames
      : [...(session.inputNames || [])];
    const feeds = {};
    for (const inputName of inputNames) {
      if (inputName === "input_ids") feeds[inputName] = tensor(ids);
      else if (inputName === "attention_mask") feeds[inputName] = tensor(attention);
      else if (inputName === "token_type_ids") feeds[inputName] = tensor(tokenTypes);
      else throw new Error(`Embedding ONNX model has an unsupported input: ${inputName}`);
    }
    if (!feeds.input_ids || !feeds.attention_mask) {
      throw new Error("Embedding ONNX model is missing required inputs");
    }
    const outputs = await session.run(feeds);
    const outputName = outputs.last_hidden_state
      ? "last_hidden_state"
      : session.outputNames && session.outputNames[0];
    const output = outputName && outputs[outputName];
    if (
      !output ||
      !Array.isArray(output.dims) ||
      output.dims.length !== 3 ||
      output.dims[0] !== 1 ||
      output.dims[1] !== ids.length ||
      output.dims[2] !== modelResult.manifest.dimension ||
      !output.data ||
      output.data.length !== ids.length * modelResult.manifest.dimension
    ) {
      throw new Error("Embedding ONNX model returned an unexpected output shape");
    }
    for (const value of output.data) {
      if (!Number.isFinite(Number(value))) {
        throw new Error("Embedding ONNX model returned a non-finite value");
      }
    }
  } finally {
    if (session && typeof session.release === "function") await session.release();
  }
}

async function validateEmbeddingStack(modelResult, options = {}) {
  await validateOrama(options);
  await validateTokenizerAndOnnx(modelResult, options);
  return { vectorReady: true, tokenizerReady: true, onnxReady: true };
}

async function runPostinstall(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const loadDatabase = options.loadDatabase || (() => require("node-sqlite3-wasm"));
  const prepareModel = options.prepareModel || prepareEmbeddingModel;
  const validateStack = options.validateStack || validateEmbeddingStack;
  const installExtension = options.installExtension || installBundledVsCodeExtension;

  let db;
  try {
    const { Database } = await loadDatabase();
    db = new Database(":memory:");
    db.exec("CREATE TABLE easy_code_install_check (id INTEGER PRIMARY KEY)");
    db.exec("CREATE VIRTUAL TABLE easy_code_fts_check USING fts5(content)");
    db.close();
    db = undefined;
    stdout.write("EASY CODE: embedded SQLite WASM is ready.\n");
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // Preserve the original validation error.
      }
    }
    stderr.write(`EASY CODE: SQLite installation check failed: ${errorMessage(error)}\n`);
    return {
      sqliteReady: false,
      modelReady: false,
      vectorStackReady: false,
      extensionResult: undefined,
    };
  }

  let modelResult;
  try {
    modelResult = await prepareModel(options.modelOptions || {});
    stdout.write(
      `EASY CODE: local embedding model is ready (${modelResult.downloaded?.length || 0} downloaded, ` +
      `${modelResult.reused?.length || 0} reused).\n`,
    );
  } catch (error) {
    stderr.write(`EASY CODE: embedding model installation failed: ${errorMessage(error)}\n`);
    return {
      sqliteReady: true,
      modelReady: false,
      vectorStackReady: false,
      extensionResult: undefined,
    };
  }

  try {
    await validateStack(modelResult, options.validationOptions || {});
    stdout.write("EASY CODE: local vector search, tokenizer, and ONNX inference are ready.\n");
  } catch (error) {
    stderr.write(`EASY CODE: embedding runtime installation check failed: ${errorMessage(error)}\n`);
    return {
      sqliteReady: true,
      modelReady: true,
      vectorStackReady: false,
      modelResult,
      extensionResult: undefined,
    };
  }

  try {
    const result = await installExtension();
    if (result.installed.length) {
      stdout.write(
        `EASY CODE: installed the bundled VS Code extension into ${result.installed.length} installation(s).\n`,
      );
    } else if (result.reason === "missing-vscode") {
      stdout.write(
        "EASY CODE: VS Code was not found. Run `node scripts/install-vscode-extension.cjs` after installing VS Code.\n",
      );
    } else if (result.reason === "missing-vsix") {
      stderr.write(
        "EASY CODE: bundled VS Code extension was not found; CLI installation will continue.\n",
      );
    }
    for (const failure of result.failed) {
      stderr.write(
        `EASY CODE: could not install the VS Code extension via ${failure.program}: ${failure.detail}\n`,
      );
    }
    return {
      sqliteReady: true,
      modelReady: true,
      vectorStackReady: true,
      modelResult,
      extensionResult: result,
    };
  } catch (error) {
    stderr.write(
      `EASY CODE: VS Code extension installation check failed: ${errorMessage(error)}\n`,
    );
    return {
      sqliteReady: true,
      modelReady: true,
      vectorStackReady: true,
      modelResult,
      extensionResult: undefined,
    };
  }
}

module.exports = {
  runPostinstall,
  validateEmbeddingStack,
  validateOrama,
  validateTokenizerAndOnnx,
};

if (require.main === module) {
  runPostinstall()
    .then((result) => {
      if (!result.sqliteReady || !result.modelReady || !result.vectorStackReady) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(`EASY CODE: installation check failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
