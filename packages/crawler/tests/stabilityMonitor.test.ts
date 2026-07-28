import { describe, expect, it } from 'vitest';
import { StabilityMonitor } from '../src/StabilityMonitor';

describe('StabilityMonitor', () => {
  it('pauses discovery when knowledge stagnates and workers stop progressing', () => {
    const monitor = new StabilityMonitor(3);
    const base = {
      queueSize: 100,
      knowledgeSize: 50,
      discovered: 200,
      processed: 40,
      memoryRss: 100_000_000,
      activeWorkers: 0,
    };

    expect(monitor.evaluate(base).verdict).toBe('continue');
    expect(monitor.evaluate({ ...base }).verdict).toBe('continue');
    expect(monitor.evaluate({ ...base }).verdict).toBe('continue');
    const fourth = monitor.evaluate({ ...base });
    expect(fourth.verdict).toBe('pause_discovery');
    expect(fourth.reason).toBe('knowledge_stagnation');
    expect(fourth.justification).toContain('Pausing new URL discovery');
  });

  it('does not pause discovery while workers are still processing', () => {
    const monitor = new StabilityMonitor(3);
    const base = {
      queueSize: 100,
      knowledgeSize: 50,
      discovered: 200,
      processed: 40,
      memoryRss: 100_000_000,
      activeWorkers: 2,
    };

    monitor.evaluate(base);
    const second = monitor.evaluate({ ...base, processed: 55, queueSize: 85 });
    expect(second.verdict).toBe('continue');
    expect(second.criteria.processedStable).toBe(false);
  });

  it('completes when queue is drained', () => {
    const monitor = new StabilityMonitor(3);
    const drained = {
      queueSize: 0,
      knowledgeSize: 10,
      discovered: 10,
      processed: 10,
      memoryRss: 50_000_000,
      activeWorkers: 0,
    };

    expect(monitor.evaluate(drained).verdict).toBe('continue');
    expect(monitor.evaluate(drained).verdict).toBe('complete');
    expect(monitor.evaluate(drained).reason).toBe('queue_drained');
  });
});
