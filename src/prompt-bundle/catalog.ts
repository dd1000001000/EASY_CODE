import type { InstalledPromptBundle, PromptBundleManifest } from "./types.js";

export type PromptTemplateValue = string | number | boolean;

export interface PromptToolMetadata {
  readonly id: string;
  readonly contractVersion: string;
  readonly description: string;
  readonly propertyDescriptions: Readonly<Record<string, string>>;
  readonly guidance: string;
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;

function parseToolMetadata(value: string, expectedId: string): PromptToolMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Prompt Bundle tool ${expectedId} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Prompt Bundle tool ${expectedId} metadata must be an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.id !== expectedId ||
    typeof record.contractVersion !== "string" ||
    typeof record.description !== "string" ||
    !record.propertyDescriptions ||
    typeof record.propertyDescriptions !== "object" ||
    Array.isArray(record.propertyDescriptions) ||
    !(
      typeof record.guidance === "string" ||
      (Array.isArray(record.guidance) && record.guidance.every((item) => typeof item === "string"))
    )
  ) {
    throw new Error(`Prompt Bundle tool ${expectedId} metadata does not match its contract`);
  }
  const propertyDescriptions = Object.fromEntries(
    Object.entries(record.propertyDescriptions as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "string") {
        throw new Error(`Prompt Bundle tool ${expectedId} has a non-text property description`);
      }
      return [key, item];
    }),
  );
  return Object.freeze({
    id: expectedId,
    contractVersion: record.contractVersion,
    description: record.description,
    propertyDescriptions: Object.freeze(propertyDescriptions),
    guidance: Array.isArray(record.guidance) ? record.guidance.join("\n") : record.guidance,
  });
}

function templateVariables(template: string, source: string): Set<string> {
  const variables = new Set<string>();
  const stripped = template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, name: string) => {
    variables.add(name);
    return "";
  });
  if (stripped.includes("{{") || stripped.includes("}}")) {
    throw new Error(`Prompt template ${source} contains an invalid placeholder`);
  }
  return variables;
}

/** Immutable, process-local view loaded only after the on-disk Bundle passed verification. */
export class PromptBundleCatalog {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly manifest: PromptBundleManifest;
  private readonly files: ReadonlyMap<string, string>;
  private readonly tools: ReadonlyMap<string, PromptToolMetadata>;

  constructor(bundle: InstalledPromptBundle, sourceFiles: ReadonlyMap<string, string>) {
    this.root = bundle.root;
    this.manifestPath = bundle.manifestPath;
    this.manifestHash = bundle.manifestHash;
    this.manifest = bundle.manifest;
    const files = new Map(sourceFiles);
    for (const relativePath of Object.keys(bundle.manifest.files)) {
      if (!files.has(relativePath)) throw new Error(`Prompt Bundle Catalog is missing ${relativePath}`);
      if (relativePath.endsWith(".md")) templateVariables(files.get(relativePath) ?? "", relativePath);
    }
    this.files = files;
    const tools = new Map<string, PromptToolMetadata>();
    for (const [toolId, entry] of Object.entries(bundle.manifest.tools)) {
      const metadata = parseToolMetadata(files.get(entry.path) ?? "", toolId);
      if (metadata.contractVersion !== entry.contractVersion) {
        throw new Error(`Prompt Bundle tool ${toolId} version does not match its manifest`);
      }
      tools.set(toolId, metadata);
    }
    this.tools = tools;
    Object.freeze(this);
  }

  readText(relativePath: string): string {
    const value = this.files.get(relativePath);
    if (value === undefined) throw new Error(`Prompt Bundle has no resource ${relativePath}`);
    return value;
  }

  getTool(toolId: string): PromptToolMetadata {
    const value = this.tools.get(toolId);
    if (!value) throw new Error(`Prompt Bundle has no tool metadata for ${toolId}`);
    return value;
  }

  listTools(): readonly string[] {
    return Object.freeze([...this.tools.keys()].sort());
  }

  render(relativePath: string, values: Readonly<Record<string, PromptTemplateValue>>): string {
    const template = this.readText(relativePath);
    const required = templateVariables(template, relativePath);
    const supplied = Object.keys(values);
    for (const [name, value] of Object.entries(values)) {
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(`Prompt template ${relativePath} variable ${name} has an invalid value`);
      }
    }
    const missing = [...required].filter((name) => !(name in values));
    const unknown = supplied.filter((name) => !required.has(name));
    if (missing.length || unknown.length) {
      const details = [
        ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
        ...(unknown.length ? [`unknown ${unknown.join(", ")}`] : []),
      ].join("; ");
      throw new Error(`Prompt template ${relativePath} variables are invalid: ${details}`);
    }
    return template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, name: string) => String(values[name]));
  }
}
