import { describe, expect, it } from 'vitest';
import { InMemoryQueue } from '../src/Queue';

describe('InMemoryQueue', () => {
  it('processes tasks sequentially by default', async () => {
    const queue = new InMemoryQueue<number>();
    const order: number[] = [];

    const first = queue.enqueue(async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(2);
      return 42;
    });

    const second = queue.enqueue(() => {
      order.push(3);
      return 7;
    });

    expect(await first).toBe(42);
    expect(await second).toBe(7);
    expect(order).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit', async () => {
    const queue = new InMemoryQueue<number>(2);
    const active: number[] = [];

    const tasks = [1, 2, 3].map((index) =>
      queue.enqueue(async () => {
        active.push(index);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active.splice(active.indexOf(index), 1);
        return index;
      }),
    );

    await Promise.all(tasks);
    expect(active.length).toBe(0);
  });

  it('drains when empty', async () => {
    const queue = new InMemoryQueue<string>();
    await queue.enqueue(() => 'ok');
    await queue.drain();
    expect(queue.isIdle()).toBe(true);
  });

  it('rejects enqueue after close', async () => {
    const queue = new InMemoryQueue<void>(1);
    await queue.close();
    await expect(queue.enqueue(() => undefined)).rejects.toThrow('Queue is closed');
  });
});
