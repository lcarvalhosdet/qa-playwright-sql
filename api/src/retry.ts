import type pg from 'pg';

// Retrying transactions that lost a race.
//
// PostgreSQL ends a transaction with one of these codes when it did nothing
// wrong but collided with another one:
//   40001 serialization_failure  (REPEATABLE READ / SERIALIZABLE)
//   40P01 deadlock_detected
// The fix is to run the whole transaction again from BEGIN: a new snapshot
// sees what the winner committed, and the outcome is decided by the data
// (success, or a business error such as SH006) instead of by timing.
//
// Every other error is final: retrying a missing product or a stock shortage
// would only give the same answer again.

export type RetryOptions = {
  /** Total tries, including the first. */
  attempts: number;
  /** Delay cap for the first retry; doubles on each retry. */
  baseDelayMs: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
};

export const defaultRetryOptions: RetryOptions = { attempts: 8, baseDelayMs: 10, maxDelayMs: 500 };

const RETRYABLE = new Set(['40001', '40P01']);

export function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && RETRYABLE.has((error as { code?: string }).code ?? '');
}

// Exponential backoff with "full jitter": a random delay between 0 and the
// cap, which doubles each time. The randomness spreads out clients that failed
// together, so they do not collide again at the same instant.
export function backoffDelay(retry: number, options: RetryOptions, random: () => number = Math.random): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (retry - 1));
  return Math.round(random() * cap);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs fn until it succeeds, a non-retryable error happens, or the attempts
// run out (then the last error is thrown). Returns the value and how many
// attempts it took; a thrown error carries the same count in `attempts`, so
// an error response can report it too. sleep and random can be replaced in tests.
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = defaultRetryOptions,
  deps: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ value: T; attempts: number }> {
  const wait = deps.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      if (!isRetryable(error) || attempt >= options.attempts) {
        if (typeof error === 'object' && error !== null) Object.assign(error, { attempts: attempt });
        throw error;
      }
      await wait(backoffDelay(attempt, options, deps.random));
    }
  }
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

// One transaction on its own connection, retried as a whole. A serialization
// failure can come from any statement or from the COMMIT itself, so the
// COMMIT is inside the retried block.
export async function inTransaction<T>(
  pool: pg.Pool,
  isolation: IsolationLevel,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: RetryOptions = defaultRetryOptions,
): Promise<{ value: T; attempts: number }> {
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }, options);
}
