import { z } from "zod";

import {
  THINKING_EFFORTS,
  type EasyCodeConfig,
} from "../core/types.js";

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
  timeoutMs: positiveInteger,
  maxRetries: z.number().int().min(0).max(10),
});

export const easyCodeConfigSchema = z.object({
  provider: z.enum(["qwen", "deepseek", "glm"]),
  mode: z.enum(["plan", "auto", "code"]),
  thinkingEffort: z.enum(THINKING_EFFORTS),
  approvalPolicy: z.enum(["safe", "ask", "never"]),
  workspaceRoot: nonEmptyString,
  dataDir: nonEmptyString,
  configDir: nonEmptyString,
  cacheDir: nonEmptyString,
  maxSteps: z.number().int().min(1).max(200),
  maxContextChars: z.number().int().min(4_096).max(2_000_000),
  maxOutputChars: z.number().int().min(256).max(1_000_000),
  commandTimeoutMs: z.number().int().min(1).max(20 * 60_000),
  qwen: providerConfigSchema,
  deepseek: providerConfigSchema,
  glm: providerConfigSchema,
});

export function validateEasyCodeConfig(value: unknown): EasyCodeConfig {
  return easyCodeConfigSchema.parse(value) as EasyCodeConfig;
}
