import type { BrowserPool } from '@autowp/browser';
import type { Queue } from '@autowp/queue';
import type { AdaptiveCrawlController } from './AdaptiveCrawlController.js';

export interface Shutdownable {
  activeWorkers: number;
}

export class ShutdownManager {
  private shutdownRequested = false;
  private shutdownResolve: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly browserPool: BrowserPool<unknown> & Shutdownable,
    private readonly adaptive: AdaptiveCrawlController,
    private readonly queue: Queue<void>,
    private readonly getFrontierLength: () => number,
    private readonly getScheduledTasksLength: () => number,
    private readonly getActiveWorkers: () => number,
  ) {}

  requestShutdown(): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    console.log('[Shutdown] Requested — waiting for workers to drain');
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  async awaitShutdown(timeoutMs = 60_000): Promise<void> {
    if (!this.shutdownRequested) {
      this.requestShutdown();
    }

    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const active = this.getActiveWorkers();
        const poolActive = this.browserPool.activeWorkers ?? 0;
        const retries = this.adaptive.getPendingRetryCount();
        const qSize = this.queue.size();
        const frontierLen = this.getFrontierLength();
        const scheduledLen = this.getScheduledTasksLength();

        if (
          active === 0 &&
          poolActive === 0 &&
          retries === 0 &&
          qSize === 0 &&
          frontierLen === 0 &&
          scheduledLen === 0
        ) {
          console.log('[Shutdown] All workers drained — closing BrowserPool');
          await this.browserPool.close();
          if (this.shutdownResolve) {
            this.shutdownResolve();
            this.shutdownResolve = null;
          }
          console.log('[Shutdown] Complete');
          return;
        }

        console.log(
          `[Shutdown] Waiting — workers:${active} pool:${poolActive} retries:${retries} queue:${qSize} frontier:${frontierLen} scheduled:${scheduledLen}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      console.warn(`[Shutdown] Timeout after ${timeoutMs}ms — forcing close`);
      await this.browserPool.close();
      if (this.shutdownResolve) {
        this.shutdownResolve();
        this.shutdownResolve = null;
      }
    };

    await poll();
  }

  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }
}
