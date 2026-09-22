export type ThreadResourceKind = "document" | "webpage";

/** Durable, model-safe description of a private resource owned by one Thread. */
export interface ThreadResourceAttachment {
  readonly id: string;
  readonly filename: string;
  readonly kind: ThreadResourceKind;
  readonly mediaType: string;
  readonly uri: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly sourceUrl?: string;
}

export interface ThreadResourceRecord extends ThreadResourceAttachment {
  readonly version: 1;
  readonly threadId: string;
  readonly contentSha256: string;
  /** Hash of the immutable source bytes, used to reuse one conversion per Thread. */
  readonly sourceSha256?: string;
  readonly totalLines: number;
}
