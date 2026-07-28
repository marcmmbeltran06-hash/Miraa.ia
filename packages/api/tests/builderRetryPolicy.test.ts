import { describe, expect, it } from 'vitest';
import { getBuilderRetryDecision } from '../src/BuilderRetryPolicy';

describe('getBuilderRetryDecision', () => {
  it('schedules recoverable failures with bounded exponential backoff', () => {
    expect(getBuilderRetryDecision(true, 0, 2, 5_000)).toEqual({
      shouldRetry: true,
      nextAttempt: 1,
      delayMs: 5_000,
    });
    expect(getBuilderRetryDecision(true, 1, 2, 5_000)).toEqual({
      shouldRetry: true,
      nextAttempt: 2,
      delayMs: 10_000,
    });
  });

  it('stops after the configured maximum', () => {
    expect(getBuilderRetryDecision(true, 2, 2, 5_000)).toEqual({
      shouldRetry: false,
      nextAttempt: 2,
      delayMs: 0,
    });
  });

  it('never retries a non-recoverable failure', () => {
    expect(getBuilderRetryDecision(false, 0, 2, 5_000).shouldRetry).toBe(false);
  });
});
