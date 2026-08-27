export {
  MemoryManager,
  type ApplyModelMemoryMutationsInput,
  type ApplyModelMemoryMutationsResult,
  type MemoryListOptions,
  type MemoryManagerOptions,
  type MemorySemanticSearchIndex,
  type MemorySearchOptions,
} from "./memory-manager.js";
export {
  EMBEDDING_DIMENSION,
  EMBEDDING_MAX_SEQUENCE_LENGTH,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_MANIFEST,
  EMBEDDING_MODEL_REVISION,
  LocalEmbeddingModel,
  resolveDefaultEmbeddingModelDirectory,
  type LocalEmbeddingModelOptions,
} from "./embedding-model.js";
export {
  MemoryVectorIndex,
  embeddingModelKey,
  type EmbeddingProvider,
  type MemoryEmbeddingBackfillResult,
  type MemoryVectorSearchHit,
  type MemoryVectorSearchOptions,
  type PreparedMemoryEmbedding,
} from "./vector-index.js";
export {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "./sensitive.js";
