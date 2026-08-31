import { createHash } from "node:crypto";

import type { PromptToolMetadata } from "../prompt-bundle/catalog.js";
import {
  canonicalJson,
  computeToolSchemaHash,
  loadPromptBundleCatalog,
} from "../prompt-bundle/index.js";

const CONTRACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

type JsonObject = Record<string, unknown>;

export interface DocumentedToolSchema {
  readonly description: string;
  readonly parameters: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneSchema(item));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneSchema(item)]),
  );
}

function documentProperties(
  schema: JsonObject,
  prefix: string,
  metadata: PromptToolMetadata,
  consumed: Set<string>,
): void {
  const properties = schema.properties;
  if (!isObject(properties)) return;
  for (const [propertyName, rawPropertySchema] of Object.entries(properties)) {
    if (!isObject(rawPropertySchema)) {
      throw new Error(`Tool ${metadata.id} schema property ${propertyName} is not an object`);
    }
    const key = prefix ? `${prefix}.${propertyName}` : propertyName;
    const description = metadata.propertyDescriptions[key];
    if (description === undefined) {
      throw new Error(`Prompt Bundle tool ${metadata.id} has no description for schema property ${key}`);
    }
    rawPropertySchema.description = description;
    consumed.add(key);

    if (rawPropertySchema.type === "array" && isObject(rawPropertySchema.items)) {
      documentProperties(rawPropertySchema.items, `${key}[]`, metadata, consumed);
    } else {
      documentProperties(rawPropertySchema, key, metadata, consumed);
    }
  }
}

/**
 * Attach verified Prompt Bundle text to an otherwise code-owned JSON Schema.
 * Runtime structure remains in TypeScript; every model-visible description is
 * loaded from the already verified, immutable process Catalog.
 */
export function documentToolSchema(
  toolId: string,
  parameters: JsonObject,
): DocumentedToolSchema {
  const metadata = loadPromptBundleCatalog().getTool(toolId);
  if (!CONTRACT_VERSION_PATTERN.test(metadata.contractVersion)) {
    throw new Error(
      `Prompt Bundle tool ${toolId} has invalid contractVersion ${metadata.contractVersion}`,
    );
  }
  const documented = cloneSchema(parameters);
  if (!isObject(documented)) throw new Error(`Tool ${toolId} parameters must be an object`);
  const consumed = new Set<string>();
  documentProperties(documented, "", metadata, consumed);
  const unknown = Object.keys(metadata.propertyDescriptions)
    .filter((key) => !consumed.has(key))
    .sort();
  if (unknown.length) {
    throw new Error(
      `Prompt Bundle tool ${toolId} has descriptions for unknown schema properties: ${unknown.join(", ")}`,
    );
  }
  return Object.freeze({
    description: metadata.description,
    parameters: documented,
  });
}

export function assertDocumentedToolSchema(
  toolId: string,
  definition: Readonly<{
    description: string;
    parameters: JsonObject;
  }>,
): void {
  const bareParameters = stripDescriptions(definition.parameters);
  if (!isObject(bareParameters)) throw new Error(`Tool ${toolId} parameters must be an object`);
  const expected = documentToolSchema(toolId, bareParameters);
  if (definition.description !== expected.description) {
    throw new Error(`Tool ${toolId} description does not match its Prompt Bundle metadata`);
  }
  if (JSON.stringify(definition.parameters) !== JSON.stringify(expected.parameters)) {
    throw new Error(`Tool ${toolId} parameter descriptions do not match its Prompt Bundle metadata`);
  }
}

/** Hash the actual schemas offered in a concrete model request/tool registry. */
export function computeToolDefinitionCatalogHash(
  definitions: readonly Readonly<{
    function: {
      name: string;
      description: string;
      parameters: JsonObject;
    };
  }>[],
): string {
  const catalog = loadPromptBundleCatalog();
  const schemas: Record<string, { contractVersion: string; schemaHash: string }> = {};
  for (const definition of definitions) {
    const id = definition.function.name;
    if (schemas[id]) throw new Error(`Duplicate tool definition ${id}`);
    assertDocumentedToolSchema(id, definition.function);
    const bareParameters = stripDescriptions(definition.function.parameters);
    if (!isObject(bareParameters)) throw new Error(`Tool ${id} parameters must be an object`);
    schemas[id] = {
      contractVersion: catalog.getTool(id).contractVersion,
      schemaHash: computeToolSchemaHash(bareParameters),
    };
  }
  return `sha256:${createHash("sha256").update(canonicalJson(schemas)).digest("hex")}`;
}

function stripDescriptions(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => propertyMap || key !== "description")
      .map(([key, item]) => [key, stripDescriptions(item, key === "properties")]),
  );
}
