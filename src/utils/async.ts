/**
 * Shared async / error helpers.
 *
 * These small utilities were previously copy-pasted across several scripts
 * (sleep, exponential backoff, and the `error instanceof Error` dance). They
 * live here so there is a single implementation to reason about and test.
 */

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff delay for a retry attempt.
 *
 * @param attempt    1-based retry attempt number.
 * @param baseDelayMs delay used for the first retry (attempt = 1).
 * @returns baseDelayMs * 2^(attempt - 1)
 */
export const backoffDelay = (attempt: number, baseDelayMs: number): number =>
  baseDelayMs * Math.pow(2, attempt - 1);

/** Extract a human-readable message from an unknown thrown value. */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
