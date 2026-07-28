import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryQueue } from '@autowp/queue';
import { SimpleScheduler } from '../src/Scheduler';

describe('SimpleScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('schedules a task after a delay', async () => {
    const queue = new InMemoryQueue<void>(1);
    const scheduler = new SimpleScheduler({ queue });
    const task = vi.fn(() => Promise.resolve());

    scheduler.scheduleAfter(100, task);
    vi.advanceTimersByTime(100);

    await queue.drain();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled task before execution', async () => {
    const scheduler = new SimpleScheduler();
    const task = vi.fn(() => Promise.resolve());
    const id = scheduler.scheduleAfter(100, task);

    scheduler.cancel(id);
    vi.advanceTimersByTime(100);

    expect(task).not.toHaveBeenCalled();
  });

  it('shuts down and closes the queue', async () => {
    const queue = new InMemoryQueue<void>(1);
    const scheduler = new SimpleScheduler({ queue });
    scheduler.scheduleAfter(100, () => Promise.resolve());

    await scheduler.shutdown();
    expect(queue.isIdle()).toBe(true);
  });
});
