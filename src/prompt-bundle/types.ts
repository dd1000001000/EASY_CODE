export const PROMPT_BUNDLE_FORMAT_VERSION = 1 as const;

export interface PromptBundleFileRecord {
  readonly sha256: string;
  readonly bytes: number;
}

export interface PromptBundleToolRecord {
  readonly path: string;
  readonly contractVersion: string;
  readonly contentHash: string;
  /** Present once the compiled runtime contract has been bound to this bundle. */
  readonly schemaHash?: string;
}

export interface PromptBundleManifest {
  readonly formatVersion: typeof PROMPT_BUNDLE_FORMAT_VERSION;
  readonly bundleVersion: string;
  readonly runtimeCompatibility: {
    readonly min: string;
    readonly maxExclusive: string;
  };
  readonly files: Readonly<Record<string, PromptBundleFileRecord>>;
  readonly tools: Readonly<Record<string, PromptBundleToolRecord>>;
  /** Hash of the canonical manifest fields above (excluding bundleHash itself). */
  readonly bundleHash: string;
}

export interface InstalledPromptBundle {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly manifest: PromptBundleManifest;
}

export interface ActivePromptBundleRecord {
  readonly formatVersion: typeof PROMPT_BUNDLE_FORMAT_VERSION;
  readonly bundleVersion: string;
  readonly directory: string;
  readonly manifestHash: string;
  readonly activatedAt: string;
}

/** Immutable resource identity persisted with every resumable session. */
export interface PromptBundleBinding {
  readonly formatVersion: typeof PROMPT_BUNDLE_FORMAT_VERSION;
  readonly bundleVersion: string;
  readonly bundleHash: string;
  readonly manifestHash: string;
  /** Hash over tool IDs, contract versions, metadata and any bound schemas. */
  readonly toolCatalogHash: string;
}
