import { Queue } from '@autowp/queue';

export type ScheduledTask<T = unknown> = () => Promise<T> | T;

export interface Scheduler {
  scheduleAt<T>(when: Date, task: ScheduledTask<T>): string;
  scheduleAfter<T>(delayMs: number, task: ScheduledTask<T>): string;
  cancel(id: string): boolean;
  shutdown(): Promise<void>;
}

interface ScheduledEntry<T = unknown> {
  timeoutId: ReturnType<typeof setTimeout>;
  task: ScheduledTask<T>;
}

export interface SchedulerOptions {
  queue?: Queue<unknown>;
}

export class SimpleScheduler implements Scheduler {
  private readonly schedule = new Map<string, ScheduledEntry>();
  private readonly queue?: Queue<unknown>;
  private closed = false;

  constructor(options: SchedulerOptions = {}) {
    this.queue = options.queue;
  }

  scheduleAt<T>(when: Date, task: ScheduledTask<T>): string {
    const delay = Math.max(0, when.getTime() - Date.now());
    return this.scheduleAfter(delay, task);
  }

  scheduleAfter<T>(delayMs: number, task: ScheduledTask<T>): string {
    if (this.closed) {
      throw new Error('Scheduler is shut down');
    }

    const id = crypto.randomUUID();
    const timeoutId = setTimeout(async () => {
      this.schedule.delete(id);
      try {
        if (this.queue) {
          await this.queue.enqueue(() => task());
        } else {
          await Promise.resolve(task());
        }
      } catch {
        // Swallow errors; consumer should capture within task.
      }
    }, delayMs);

    this.schedule.set(id, { timeoutId, task });
    return id;
  }

  cancel(id: string): boolean {
    const entry = this.schedule.get(id);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timeoutId);
    this.schedule.delete(id);
    return true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const entry of this.schedule.values()) {
      clearTimeout(entry.timeoutId);
    }
    this.schedule.clear();
    if (this.queue && typeof this.queue.close === 'function') {
      await this.queue.close();
    }
  }
}
