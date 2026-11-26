import { test, expect } from '@playwright/test';
import { backoffDelay, isRetryable, withRetry, type RetryOptions } from '../../api/src/retry.ts';

// Unit tests for api/src/retry.ts: no database, no network. The function being
// retried is a fake that fails as told, and sleep only records the delays.

const options: RetryOptions = { attempts: 4, baseDelayMs: 10, maxDelayMs: 50 };
const pgError = (code: string) => Object.assign(new Error(`error ${code}`), { code });

// A function that throws the given errors in order, then returns 'done'.
function failing(...errors: Error[]) {
  const calls: number[] = [];
  const fn = async (attempt: number) => {
    calls.push(attempt);
    const error = errors[attempt - 1];
    if (error) throw error;
    return 'done';
  };
  return { fn, calls };
}

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

test.describe('withRetry', () => {
  test('returns at once when the first attempt works', async () => {
    const { fn, calls } = failing();
    const { delays, sleep } = recordingSleep();

    expect(await withRetry(fn, options, { sleep })).toEqual({ value: 'done', attempts: 1 });
    expect(calls).toEqual([1]);
    expect(delays).toEqual([]);
  });

  test('retries a serialization failure and a deadlock, then succeeds', async () => {
    const { fn, calls } = failing(pgError('40001'), pgError('40P01'));
    const { delays, sleep } = recordingSleep();

    expect(await withRetry(fn, options, { sleep, random: () => 1 })).toEqual({ value: 'done', attempts: 3 });
    expect(calls).toEqual([1, 2, 3]);
    expect(delays).toEqual([10, 20]); // one wait before each retry
  });

  test('gives up after the last attempt and throws the last error', async () => {
    const { fn, calls } = failing(pgError('40001'), pgError('40001'), pgError('40001'), pgError('40P01'));
    const { sleep } = recordingSleep();

    await expect(withRetry(fn, options, { sleep })).rejects.toMatchObject({ code: '40P01', attempts: 4 });
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  for (const code of ['SH001', '23514', 'P0002', '22023']) {
    test(`does not retry ${code}: the same request would fail the same way`, async () => {
      const { fn, calls } = failing(pgError(code));
      const { delays, sleep } = recordingSleep();

      await expect(withRetry(fn, options, { sleep })).rejects.toMatchObject({ code, attempts: 1 });
      expect(calls).toEqual([1]);
      expect(delays).toEqual([]);
    });
  }

  test('does not retry an error without a code', async () => {
    const { fn, calls } = failing(new Error('connection refused'));
    await expect(withRetry(fn, options, recordingSleep())).rejects.toThrow('connection refused');
    expect(calls).toEqual([1]);
  });
});

test.describe('backoffDelay', () => {
  test('the cap doubles on each retry up to the maximum', () => {
    const caps = [1, 2, 3, 4, 5, 6].map((retry) => backoffDelay(retry, options, () => 1));
    expect(caps).toEqual([10, 20, 40, 50, 50, 50]);
  });

  test('full jitter: the delay is anywhere between 0 and the cap', () => {
    expect(backoffDelay(3, options, () => 0)).toBe(0);
    expect(backoffDelay(3, options, () => 0.5)).toBe(20);
    for (let i = 0; i < 200; i++) {
      const delay = backoffDelay(3, options);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(40);
    }
  });
});

test('isRetryable accepts only 40001 and 40P01', () => {
  expect(['40001', '40P01', '40002', 'SH001', '23505'].map((code) => isRetryable(pgError(code)))).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  expect(isRetryable(null)).toBe(false);
  expect(isRetryable('40001')).toBe(false);
});
