import { describe, expect, it } from 'vitest';
import { classifyBuilderActivity, shouldTerminateBuilderForInactivity } from '../src/BuilderLiveness';

describe('builder liveness', () => {
  it('never cancels an active build because of its total duration', () => {
    const twelveHours = 12 * 60 * 60 * 1_000;
    expect(shouldTerminateBuilderForInactivity(0, twelveHours)).toBe(false);
    expect(shouldTerminateBuilderForInactivity(0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('uses only an explicitly configured no-activity threshold', () => {
    expect(shouldTerminateBuilderForInactivity(900_000, 899_999)).toBe(false);
    expect(shouldTerminateBuilderForInactivity(900_000, 900_001)).toBe(true);
  });

  it('reports slow work separately without treating it as completion', () => {
    expect(classifyBuilderActivity(60_000)).toBe('active');
    expect(classifyBuilderActivity(600_001)).toBe('slow_or_blocked');
  });
});
