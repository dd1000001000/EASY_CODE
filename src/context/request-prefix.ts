import type { ChatMessage, ToolDefinition } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

/** Diagnostics only: not provider tokenization, billing, or a cache-hit claim.
 * Retain hashes/lengths, never another copy of private reasoning or tool output.
 */
export class RequestPrefixTracker {
  private previous?: { key: string; blocks: Array<{ hash: string; chars: number }> };

  observe(key: string, messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []) {
    const blocks = [tools, ...messages].map((value) => {
      const serialized = JSON.stringify(value);
      return { hash: sha256(serialized), chars: serialized.length };
    });
    const previous = this.previous?.key === key ? this.previous.blocks : undefined;
    let unchangedPrefixChars = 0;
    if (previous) for (let index = 0; index < Math.min(previous.length, blocks.length); index += 1) {
      if (previous[index]!.hash !== blocks[index]!.hash) break;
      unchangedPrefixChars += blocks[index]!.chars;
    }
    this.previous = { key, blocks };
    return {
      hasPrefixBaseline: previous !== undefined,
      unchangedPrefixChars,
      previousSerializedChars: previous?.reduce((total, block) => total + block.chars, 0) ?? 0,
    };
  }
}
