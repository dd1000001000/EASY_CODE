import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  fsyncSync,
  statSync,
  truncateSync,
} from "node:fs";
import path from "node:path";
import type { EventRecord } from "../core/types.js";
import { createId } from "../utils/ids.js";

export interface AppendEventInput {
  readonly type: string;
  readonly payload: unknown;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly phase?: EventRecord["phase"];
  readonly eventId?: string;
  readonly timestamp?: string;
  readonly schemaVersion?: number;
}

export interface EventJournalOptions {
  /** False opens an existing journal for read-only discovery without mkdir. */
  readonly createDirectory?: boolean;
}

interface JournalScan {
  readonly events: EventRecord[];
  readonly validLength: number;
  readonly needsNewline: boolean;
  readonly damagedTail: boolean;
}

interface JournalFileIdentity {
  readonly exists: boolean;
  readonly device?: bigint;
  readonly inode?: bigint;
  readonly size?: bigint;
  readonly modifiedAt?: bigint;
  readonly changedAt?: bigint;
}

interface CachedJournalScan {
  readonly identity: JournalFileIdentity;
  readonly scan: JournalScan;
}

const MAX_STABLE_SCAN_ATTEMPTS = 3;

function assertSafeThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(threadId)) {
    throw new Error(`Invalid thread id: ${threadId}`);
  }
}

function hasNonWhitespace(buffer: Buffer, start: number): boolean {
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return true;
    }
  }
  return false;
}

function parseEvent(value: string, expectedThreadId: string): EventRecord {
  const parsed = JSON.parse(value) as Partial<EventRecord>;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.schemaVersion !== "number" ||
    typeof parsed.eventId !== "string" ||
    typeof parsed.threadId !== "string" ||
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 1 ||
    typeof parsed.timestamp !== "string" ||
    typeof parsed.type !== "string" ||
    !("payload" in parsed)
  ) {
    throw new Error("Invalid journal event record");
  }
  if (parsed.threadId !== expectedThreadId) {
    throw new Error(
      `Journal event belongs to ${parsed.threadId}, expected ${expectedThreadId}`,
    );
  }
  return parsed as EventRecord;
}

function journalFileIdentity(filePath: string): JournalFileIdentity {
  try {
    const stats = statSync(filePath, { bigint: true });
    if (!stats.isFile()) {
      throw new Error(`Thread journal is not a regular file: ${filePath}`);
    }
    return {
      exists: true,
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modifiedAt: stats.mtimeNs,
      changedAt: stats.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

function sameJournalFileIdentity(
  left: Readonly<JournalFileIdentity>,
  right: Readonly<JournalFileIdentity>,
): boolean {
  return left.exists === right.exists &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt;
}

function freezeJsonValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeJsonValue(child);
  }
  Object.freeze(value);
}

function immutableEvent(event: EventRecord): EventRecord {
  freezeJsonValue(event.payload);
  return Object.freeze(event);
}

/**
 * Append-only, per-thread JSONL journal. It is the durable source of truth for a
 * thread; database rows are query projections only.
 */
export class EventJournal {
  readonly threadId: string;
  readonly filePath: string;
  private cachedScan?: CachedJournalScan;
  private cachedEventIds?: Set<string>;

  constructor(
    dataDir: string,
    threadId: string,
    options: EventJournalOptions = {},
  ) {
    assertSafeThreadId(threadId);
    this.threadId = threadId;
    const threadDir = path.join(path.resolve(dataDir), "threads", threadId);
    if (options.createDirectory !== false) mkdirSync(threadDir, { recursive: true });
    this.filePath = path.join(threadDir, "events.jsonl");
  }

  append(input: AppendEventInput): EventRecord {
    if (!input.type.trim()) throw new Error("Event type must not be empty");
    if (input.payload === undefined) {
      throw new Error("Event payload must be JSON-serializable and cannot be undefined");
    }

    const scan = this.scan();
    if (scan.damagedTail) {
      truncateSync(this.filePath, scan.validLength);
      this.cachedScan = undefined;
      this.cachedEventIds = undefined;
    }
    const previous = scan.events[scan.events.length - 1];
    const eventId = input.eventId ?? createId("event");
    const eventIds = this.cachedEventIds ?? new Set(
      scan.events.map((event) => event.eventId),
    );
    if (eventIds.has(eventId)) {
      throw new Error(`Duplicate event id: ${eventId}`);
    }

    const record: EventRecord = {
      schemaVersion: input.schemaVersion ?? 1,
      eventId,
      threadId: this.threadId,
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      payload: input.payload,
    };
    if (input.turnId !== undefined) record.turnId = input.turnId;
    if (input.stepId !== undefined) record.stepId = input.stepId;
    if (input.phase !== undefined) record.phase = input.phase;

    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Event payload is not JSON-serializable: ${message}`);
    }
    const separator = scan.needsNewline ? "\n" : "";
    const appendedText = `${separator}${serialized}\n`;
    appendFileSync(this.filePath, appendedText, {
      encoding: "utf8",
      flag: "a",
    });
    this.flush();
    const identity = journalFileIdentity(this.filePath);
    const expectedSize = BigInt(scan.validLength + Buffer.byteLength(appendedText, "utf8"));
    if (identity.exists && identity.size === expectedSize) {
      // Cache a parsed, detached record. The input payload and append() return
      // value retain their historical mutability without being able to poison
      // sequence or duplicate-ID validation in this trusted cache.
      const cachedRecord = immutableEvent(parseEvent(serialized, this.threadId));
      scan.events.push(cachedRecord);
      eventIds.add(cachedRecord.eventId);
      this.cachedScan = {
        identity,
        scan: {
          events: scan.events,
          validLength: Number(expectedSize),
          needsNewline: false,
          damagedTail: false,
        },
      };
      this.cachedEventIds = eventIds;
    } else {
      // An external writer changed the file across our append boundary. Never
      // derive a future sequence from the optimistic in-memory view.
      this.cachedScan = undefined;
      this.cachedEventIds = undefined;
    }
    return record;
  }

  read(): EventRecord[] {
    return [...this.scan().events];
  }

  readAfter(sequence: number): EventRecord[] {
    return this.read().filter((event) => event.sequence > sequence);
  }

  private flush(): void {
    // Windows does not permit fsync on a read-only descriptor. Opening in append
    // mode preserves the journal while giving fsync a writable handle.
    const descriptor = openSync(this.filePath, "a");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private scan(): JournalScan {
    let before = journalFileIdentity(this.filePath);
    if (
      this.cachedScan &&
      sameJournalFileIdentity(this.cachedScan.identity, before)
    ) {
      return this.cachedScan.scan;
    }

    for (let attempt = 1; attempt <= MAX_STABLE_SCAN_ATTEMPTS; attempt += 1) {
      const scan = this.scanFile();
      const after = journalFileIdentity(this.filePath);
      if (sameJournalFileIdentity(before, after)) {
        this.cachedScan = { identity: after, scan };
        this.cachedEventIds = new Set(scan.events.map((event) => event.eventId));
        return scan;
      }
      before = after;
    }
    this.cachedScan = undefined;
    this.cachedEventIds = undefined;
    throw new Error("Thread journal changed repeatedly while it was being read");
  }

  private scanFile(): JournalScan {
    if (!existsSync(this.filePath)) {
      return {
        events: [],
        validLength: 0,
        needsNewline: false,
        damagedTail: false,
      };
    }

    const buffer = readFileSync(this.filePath);
    const events: EventRecord[] = [];
    const eventIds = new Set<string>();
    let cursor = 0;
    let validLength = 0;
    let needsNewline = false;
    let damagedTail = false;

    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      const lineEnd = newline === -1 ? buffer.length : newline;
      let contentEnd = lineEnd;
      if (contentEnd > cursor && buffer[contentEnd - 1] === 0x0d) contentEnd -= 1;
      const line = buffer.subarray(cursor, contentEnd).toString("utf8");

      if (line.trim().length > 0) {
        try {
          const event = parseEvent(line, this.threadId);
          const previous = events[events.length - 1];
          const expectedSequence = (previous?.sequence ?? 0) + 1;
          if (event.sequence !== expectedSequence) {
            throw new Error(
              `Invalid journal sequence ${event.sequence}; expected ${expectedSequence}`,
            );
          }
          if (eventIds.has(event.eventId)) {
            throw new Error(`Duplicate event id: ${event.eventId}`);
          }
          eventIds.add(event.eventId);
          events.push(immutableEvent(event));
        } catch (error) {
          const nextOffset = newline === -1 ? buffer.length : newline + 1;
          if (hasNonWhitespace(buffer, nextOffset)) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Journal is corrupt before its tail: ${message}`);
          }
          damagedTail = true;
          break;
        }
      }

      if (newline === -1) {
        validLength = buffer.length;
        needsNewline = line.trim().length > 0;
        break;
      }
      validLength = newline + 1;
      cursor = newline + 1;
    }

    return { events, validLength, needsNewline, damagedTail };
  }
}
