export class ReviewFatalError extends Error {}
export class ReviewPersistenceError extends ReviewFatalError {
  constructor(cause: unknown) { super(`Review journal could not be persisted: ${String(cause)}`); }
}
export class ReviewCleanupError extends ReviewFatalError {
  constructor(cause: unknown) { super(`Review process cleanup could not be confirmed: ${String(cause)}`); }
}
export function durableReviewWrite<T>(write: () => T): T {
  try { return write(); } catch (error) { throw new ReviewPersistenceError(error); }
}
