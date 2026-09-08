import type { ChatMessage, ProviderUsage, ToolDefinition } from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { sha256 } from "../utils/hash.js";
import { requestTokens } from "./token-budget.js";

/** Estimates are versioned by serializer policy, endpoint/model and modality.
 * No credentials, messages or thinking are stored in calibration records. */
export class TokenCalibration {
  private readonly samples = new Map<string, number[]>();
  private readonly scope: string;
  constructor(identity: string, private readonly storage?: EasyCodeStorage) {
    this.scope = sha256(`request-estimator-v1:${identity}`);
  }

  private key(messages: readonly ChatMessage[]): string {
    return `${this.scope}:${messages.some((m) => m.role === "user" && m.images?.length) ? "images" : "text"}`;
  }

  private ratios(key: string): number[] {
    let values = this.samples.get(key);
    if (!values) {
      const rows = this.storage?.db.prepare<[string], { ratio: number }>(
        "SELECT ratio FROM context_token_samples WHERE scope = ? ORDER BY sequence DESC LIMIT 32").all(key);
      values = (rows ?? []).map((r) => r.ratio).reverse();
      this.samples.set(key, values);
    }
    return values;
  }

  estimate(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []): number {
    // Raise quickly on under-estimates, decay only as old samples leave the
    // bounded window. Never undercut the conservative uncalibrated baseline.
    const ratios = this.ratios(this.key(messages));
    const factor = Math.max(1, ...ratios.map((ratio) => ratio * 1.1));
    return Math.ceil(requestTokens(messages, tools) * factor);
  }

  observe(messages: readonly ChatMessage[], tools: readonly ToolDefinition[], usage?: ProviderUsage): void {
    const actual = usage?.promptTokens;
    const baseline = requestTokens(messages, tools);
    if (!Number.isSafeInteger(actual) || actual! < 128 || baseline < 128) return;
    // promptTokens is the adapter-normalized total input, including cache hits.
    // Neither cachedInputTokens nor reasoningTokens is added a second time.
    const ratio = actual! / baseline;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const key = this.key(messages);
    const values = this.ratios(key);
    values.push(ratio);
    if (values.length > 32) values.shift();
    if (this.storage) this.storage.db.transaction(() => {
      this.storage!.db.prepare("INSERT INTO context_token_samples(scope, ratio) VALUES (?, ?)").run(key, ratio);
      this.storage!.db.prepare(`DELETE FROM context_token_samples WHERE scope = ? AND sequence NOT IN
        (SELECT sequence FROM context_token_samples WHERE scope = ? ORDER BY sequence DESC LIMIT 32)`).run(key, key);
    })();
  }
}
