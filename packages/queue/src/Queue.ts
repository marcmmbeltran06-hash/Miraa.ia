export type QueueTask<T> = () => Promise<T> | T;

export interface Queue<T = unknown> {
  enqueue(task: QueueTask<T>): Promise<T>;
  size(): number;
  isIdle(): boolean;
  drain(): Promise<void>;
  close(): Promise<void>;
  /** Discard all pending (not-yet-started) tasks, rejecting their promises. */
  clear(): void;
  /** Dynamically change the maximum number of concurrent tasks. */
  setConcurrency(n: number): void;
}

interface PendingTask<T> {
  task: QueueTask<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
}

export class InMemoryQueue<T = unknown> implements Queue<T> {
  private concurrency: number;
  private readonly pending: PendingTask<T>[] = [];
  private activeCount = 0;
  private closed = false;
  private idleResolvers: Array<() => void> = [];
  private closeResolver?: () => void;

  constructor(concurrency = 1) {
    if (concurrency < 1) {
      throw new Error('Queue concurrency must be at least 1');
    }
    this.concurrency = concurrency;
  }

  setConcurrency(n: number): void {
    if (n < 1) {
      throw new Error('Concurrency must be at least 1');
    }
    this.concurrency = n;
  }

  enqueue(task: QueueTask<T>): Promise<T> {
    if (this.closed) {
      if (process.env.NODE_ENV === 'test') console.error(`[DEBUG-QUEUE] enqueue rejected: queue closed`);
      return Promise.reject(new Error('Queue is closed'));
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.scheduleNext();
    });
  }

  size(): number {
    return this.pending.length + this.activeCount;
  }

  isIdle(): boolean {
    return this.pending.length === 0 && this.activeCount === 0;
  }

  async drain(): Promise<void> {
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.isIdle()) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
  }

  private scheduleNext(): void {
    if (this.activeCount >= this.concurrency) {
      return;
    }

    const nextTask = this.pending.shift();
    if (!nextTask) {
      if (this.isIdle()) {
        this.resolveIdle();
      }
      if (this.closed && this.closeResolver) {
        this.closeResolver();
      }
      return;
    }

    this.activeCount += 1;

    Promise.resolve()
      .then(() => nextTask.task())
      .then((result) => nextTask.resolve(result))
      .catch((error) => nextTask.reject(error))
      .finally(() => {
        this.activeCount -= 1;
        this.scheduleNext();
      });
  }

  clear(): void {
    const err = new Error('Task discarded by queue clear()');
    for (const pending of this.pending) {
      pending.reject(err);
    }
    this.pending.length = 0;
  }

  private resolveIdle(): void {
    this.idleResolvers.forEach((resolve) => resolve());
    this.idleResolvers = [];
  }
}
