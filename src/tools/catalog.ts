import { createHash } from "node:crypto";

import type { AgentTool, ToolRuntimeMetadata } from "../core/types.js";
import { canonicalJson } from "../prompt-bundle/index.js";
import { toolMetadata, validateToolMetadata } from "./capabilities.js";

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

export interface ToolCatalogBinding {
  readonly toolId: string;
  readonly modelName: string;
  readonly sourceId: string;
  readonly sourceKind: ToolRuntimeMetadata["identity"]["sourceKind"];
  readonly sourceVersion?: string;
  readonly schemaHash: string;
  readonly metadataHash: string;
  readonly catalogRevision: number;
  readonly catalogHash: string;
}

export interface ToolCatalogSnapshot {
  readonly revision: number;
  readonly hash: string;
  readonly tools: readonly AgentTool[];
  readonly bindings: ReadonlyMap<string, ToolCatalogBinding>;
}

export interface ToolSource {
  readonly id: string;
  readonly kind: "builtin" | "external";
  readonly priority?: number;
  start?(): Promise<void>;
  listTools(): Promise<readonly AgentTool[]>;
  close?(): Promise<void>;
}

export class StaticToolSource implements ToolSource {
  constructor(
    readonly id: string,
    private readonly tools: readonly AgentTool[],
    readonly kind: "builtin" | "external" = "builtin",
    readonly priority = kind === "builtin" ? 0 : 100,
  ) {}

  async listTools(): Promise<readonly AgentTool[]> {
    return this.tools;
  }
}

function schemaHash(tool: Readonly<AgentTool>): string {
  const payload = {
    name: tool.definition.function.name,
    description: tool.definition.function.description,
    parameters: tool.definition.function.parameters,
    strict: tool.definition.function.strict ?? false,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function metadataHash(tool: Readonly<AgentTool>): string {
  const metadata = toolMetadata(tool);
  const payload = {
    identity: metadata.identity,
    effects: [...metadata.effects],
    allowedModes: [...metadata.allowedModes],
    allowedRoles: [...metadata.allowedRoles],
    taskWork: metadata.taskWork,
    progressExperiment: metadata.progressExperiment,
    requiresOrchestration: metadata.requiresOrchestration,
    requiresVision: metadata.requiresVision,
    validationSensitive: metadata.validationSensitive,
    idempotent: metadata.idempotent,
    controlPlane: metadata.controlPlane,
    resultClass: metadata.resultClass,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

/** Preserve executable state in the source object while freezing request-visible identity and schema. */
function snapshotTool(tool: AgentTool): AgentTool {
  const metadata = toolMetadata(tool);
  const frozenMetadata = Object.freeze({
    ...metadata,
    identity: Object.freeze({ ...metadata.identity }),
    effects: Object.freeze([...metadata.effects]),
    allowedModes: Object.freeze([...metadata.allowedModes]),
    allowedRoles: Object.freeze([...metadata.allowedRoles]),
  });
  const definition = deepFreezeJson(JSON.parse(canonicalJson(tool.definition))) as AgentTool["definition"];
  return Object.freeze({
    name: tool.name,
    definition,
    mutating: tool.mutating,
    metadata: frozenMetadata,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    execute: (input: unknown, context: Parameters<AgentTool["execute"]>[1]) => tool.execute(input, context),
  });
}

function catalogHash(bindings: readonly Omit<ToolCatalogBinding, "catalogRevision" | "catalogHash">[]): string {
  // Tool order is provider-visible and affects prompt-cache identity, so it is
  // deliberately part of the catalog hash rather than normalized away.
  const canonical = bindings
    .map(({ toolId, modelName, sourceId, sourceKind, sourceVersion, schemaHash: schema, metadataHash: metadata }) => ({
      toolId, modelName, sourceId, sourceKind, sourceVersion: sourceVersion ?? null,
      schemaHash: schema, metadataHash: metadata,
    }));
  return `sha256:${createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
}

export function snapshotToolSet(
  tools: readonly AgentTool[],
  revision = 1,
): ToolCatalogSnapshot {
  const names = new Set<string>();
  const ids = new Set<string>();
  const snapshotTools = tools.map((tool) => snapshotTool(tool));
  const partial = snapshotTools.map((tool) => {
    if (tool.definition.function.name !== tool.name) {
      throw new Error(`Tool ${tool.name} definition name does not match its registry name`);
    }
    const metadata = toolMetadata(tool);
    if (names.has(tool.name)) throw new Error(`Duplicate model-facing tool name ${tool.name}`);
    if (ids.has(metadata.identity.id)) throw new Error(`Duplicate stable tool id ${metadata.identity.id}`);
    names.add(tool.name);
    ids.add(metadata.identity.id);
    return {
      toolId: metadata.identity.id,
      modelName: tool.name,
      sourceId: metadata.identity.sourceId,
      sourceKind: metadata.identity.sourceKind,
      ...(metadata.identity.sourceVersion ? { sourceVersion: metadata.identity.sourceVersion } : {}),
      schemaHash: schemaHash(tool),
      metadataHash: metadataHash(tool),
    } satisfies Omit<ToolCatalogBinding, "catalogRevision" | "catalogHash">;
  });
  const hash = catalogHash(partial);
  const bindings = new Map<string, ToolCatalogBinding>();
  for (const binding of partial) {
    bindings.set(binding.modelName, Object.freeze({ ...binding, catalogRevision: revision, catalogHash: hash }));
  }
  return Object.freeze({
    revision,
    hash,
    tools: Object.freeze(snapshotTools),
    bindings: new ImmutableMap(bindings),
  });
}

function validateSourceTool(source: Readonly<ToolSource>, tool: Readonly<AgentTool>): Readonly<ToolRuntimeMetadata> {
  if (tool.definition.function.name !== tool.name) {
    throw new Error(`Tool ${tool.name} definition name does not match its registry name`);
  }
  if (source.kind === "external" && !tool.metadata) {
    throw new Error(`External tool ${tool.name} must have Runtime-owned capability metadata`);
  }
  const metadata = toolMetadata(tool);
  validateToolMetadata(tool, metadata);
  if (metadata.identity.sourceId !== source.id || metadata.identity.sourceKind !== source.kind) {
    throw new Error(`Tool ${tool.name} metadata does not match source ${source.id}`);
  }
  return metadata;
}

/** Mutable source manager that publishes immutable per-request snapshots. */
export class ToolCatalog {
  private readonly sources = new Map<string, ToolSource>();
  private readonly startedSources = new Set<string>();
  private revision = 0;
  private lastHash = "";

  registerSource(source: ToolSource): void {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(source.id)) throw new Error(`Invalid tool source id ${source.id}`);
    if (this.sources.has(source.id)) throw new Error(`Tool source already registered: ${source.id}`);
    this.sources.set(source.id, source);
  }

  async removeSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) return;
    this.sources.delete(sourceId);
    this.startedSources.delete(sourceId);
    await source.close?.();
  }

  async snapshot(): Promise<ToolCatalogSnapshot> {
    const sources = [...this.sources.values()].sort((left, right) =>
      (left.priority ?? 100) - (right.priority ?? 100) || left.id.localeCompare(right.id));
    const tools: AgentTool[] = [];
    const partialBindings: Array<Omit<ToolCatalogBinding, "catalogRevision" | "catalogHash">> = [];
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const source of sources) {
      if (!this.startedSources.has(source.id)) {
        await source.start?.();
        this.startedSources.add(source.id);
      }
      const listed = [...await source.listTools()];
      if (source.kind === "external") listed.sort((left, right) => left.name.localeCompare(right.name));
      for (const tool of listed) {
        const metadata = validateSourceTool(source, tool);
        if (names.has(tool.name)) throw new Error(`Duplicate model-facing tool name ${tool.name}`);
        if (ids.has(metadata.identity.id)) throw new Error(`Duplicate stable tool id ${metadata.identity.id}`);
        names.add(tool.name);
        ids.add(metadata.identity.id);
        const view = snapshotTool(tool);
        tools.push(view);
        partialBindings.push({
          toolId: metadata.identity.id,
          modelName: tool.name,
          sourceId: metadata.identity.sourceId,
          sourceKind: metadata.identity.sourceKind,
          ...(metadata.identity.sourceVersion ? { sourceVersion: metadata.identity.sourceVersion } : {}),
          schemaHash: schemaHash(view),
          metadataHash: metadataHash(view),
        });
      }
    }
    const hash = catalogHash(partialBindings);
    if (hash !== this.lastHash) {
      this.revision += 1;
      this.lastHash = hash;
    }
    const bindings = new Map<string, ToolCatalogBinding>();
    for (const binding of partialBindings) {
      bindings.set(binding.modelName, Object.freeze({ ...binding, catalogRevision: this.revision, catalogHash: hash }));
    }
    return Object.freeze({
      revision: this.revision,
      hash,
      tools: Object.freeze([...tools]),
      bindings: new ImmutableMap(bindings),
    });
  }

  async close(): Promise<void> {
    const sources = [...this.sources.values()];
    this.sources.clear();
    this.startedSources.clear();
    await Promise.all(sources.map((source) => source.close?.()));
  }
}

/** Compatibility helper for one already-resolved Runtime tool set. */
export async function snapshotBuiltinTools(tools: readonly AgentTool[]): Promise<ToolCatalogSnapshot> {
  const catalog = new ToolCatalog();
  catalog.registerSource(new StaticToolSource("builtin", tools));
  return catalog.snapshot();
}
