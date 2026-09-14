/**
 * Process-local authorization bridge between read_memory and write_memory.
 * A revision or expiration may target only an ID returned to the model by
 * read_memory in the same turn. The durable MemoryManager remains the final
 * workspace-scoped authority.
 */
export class MemoryToolSession {
  private static readonly maxReturnedIds = 100;
  private activeTurnId: string | undefined;
  private readonly returnedIds = new Set<string>();

  beginTurn(turnId: string): void {
    if (this.activeTurnId === turnId) return;
    this.activeTurnId = turnId;
    this.returnedIds.clear();
  }

  record(turnId: string, ids: readonly string[]): void {
    this.beginTurn(turnId);
    for (const id of ids) {
      if (!this.returnedIds.has(id) && this.returnedIds.size >= MemoryToolSession.maxReturnedIds) {
        const oldest = this.returnedIds.values().next().value as string | undefined;
        if (oldest) this.returnedIds.delete(oldest);
      }
      this.returnedIds.add(id);
    }
  }

  assertReturned(turnId: string, memoryId: string): void {
    this.beginTurn(turnId);
    if (!this.returnedIds.has(memoryId)) {
      throw new Error(
        "revise and forget require a memory ID returned by read_memory in this turn",
      );
    }
  }
}
