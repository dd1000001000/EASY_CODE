import { z } from "zod";

import {
  THINKING_EFFORTS,
  type EasyCodeConfig,
} from "../core/types.js";
import { isProviderName } from "../models/catalog.js";
import { runtimeLimitsSchema } from "./runtime-limits.js";

const nonEmptyString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must use the http or https protocol");

export const providerConfigSchema = z.object({
  apiKey: nonEmptyString.optional(),
  baseUrl: httpUrl,
  model: nonEmptyString,
  timeoutMs: positiveInteger.optional(),
  maxRetries: z.number().int().min(0).max(10),
});

export const easyCodeConfigSchema = z.object({
  approvalModel: nonEmptyString.optional(),
  provider: nonEmptyString.refine(isProviderName, "is not present in ~/.easy_code/models.toml"),
  mode: z.enum(["plan", "auto", "code"]),
  thinkingEffort: z.enum(THINKING_EFFORTS),
  approvalPolicy: z.enum(["safe", "ask", "never"]),
  workspaceRoot: nonEmptyString,
  dataDir: nonEmptyString,
  configDir: nonEmptyString,
  cacheDir: nonEmptyString,
  limits: runtimeLimitsSchema,
  orchestrationEnabled: z.boolean(),
  subagentIsolation: z.enum(["auto", "shared", "worktree"]),
  worktreeBaseMode: z.enum(["fresh", "head", "current-snapshot"]),
  worktreeRoot: nonEmptyString,
  providers: z.record(nonEmptyString, providerConfigSchema),
  modelRegistryHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  // Compatibility aliases remain during the persisted-config migration.
  qwen: providerConfigSchema,
  deepseek: providerConfigSchema,
  kimi: providerConfigSchema,
  glm: providerConfigSchema,
  "glm-coding-plan": providerConfigSchema,
});

export function validateEasyCodeConfig(value: unknown): EasyCodeConfig {
  return easyCodeConfigSchema.parse(value) as EasyCodeConfig;
}
