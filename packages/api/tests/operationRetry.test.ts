import { describe, expect, it, vi } from 'vitest';
import { retryOperation } from '../src/OperationRetry.js';

describe('retryOperation', () => {
  it.each(['Docker', 'WP-CLI'])('recovers from a temporary %s failure with exponential waits', async (operation) => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error(`${operation} temporarily unavailable`))
      .mockRejectedValueOnce(new Error(`${operation} still starting`))
      .mockResolvedValue('ready');
    const delays: number[] = [];

    const result = await retryOperation(operation, action, {
      attempts: 3,
      baseDelayMs: 100,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(result).toBe('ready');
    expect(action).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it('returns a clear error after the configured operation attempts', async () => {
    await expect(retryOperation('docker compose up', async () => {
      throw new Error('daemon offline');
    }, {
      attempts: 2,
      baseDelayMs: 0,
      sleep: async () => undefined,
    })).rejects.toThrow('docker compose up failed after 2 attempt(s): daemon offline');
  });
});
