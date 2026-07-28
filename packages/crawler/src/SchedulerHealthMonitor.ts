import type { BrowserPool } from '@autowp/browser';
import type { Queue } from '@autowp/queue';

/**
 * SchedulerHealthMonitor tracks the health of the crawling scheduler and workers.
 * It records active/idle/blocked workers, pending promises, open browser pages,
 * and resource usage. The monitor is consulted by the stability check to decide
 * when the crawler can safely terminate.
 */
export class SchedulerHealthMonitor {
  private activeWorkers = 0;
  private idleWorkers = 0;
  private blockedWorkers = 0;
  private pendingPromises = 0;
  private lastDiscovery = 0;
  private lastProcessed = 0;
  private browserPool: BrowserPool<unknown>;
  private queue: Queue<void>;

  constructor(browserPool: BrowserPool<unknown>, queue: Queue<void>) {
    this.browserPool = browserPool;
    this.queue = queue;
  }

  // Call when a worker starts processing a page
  workerStarted() {
    this.activeWorkers++;
    this.idleWorkers = Math.max(0, this.idleWorkers - 1);
  }

  // Call when a worker finishes processing a page
  workerFinished() {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.idleWorkers++;
  }

  // Call when a worker appears to be blocked (e.g., no progress for X ms)
  workerBlocked() {
    this.blockedWorkers++;
  }

  // Reset blocked count after a successful progress step
  resetBlocked() {
    this.blockedWorkers = 0;
  }

  // Record a pending promise (e.g., a page fetch)
  incPending() {
    this.pendingPromises++;
  }

  decPending() {
    this.pendingPromises = Math.max(0, this.pendingPromises - 1);
  }

  // Update timestamps for discovery/processing events
  markDiscovery() {
    this.lastDiscovery = Date.now();
  }

  markProcessed() {
    this.lastProcessed = Date.now();
  }

  // Gather current health snapshot
  snapshot() {
    const memory = process.memoryUsage();
    const poolWorkers = (this.browserPool as unknown as { activeWorkers?: number }).activeWorkers ?? 0;
    return {
      workersActive: this.activeWorkers,
      workersIdle: this.idleWorkers,
      workersBlocked: this.blockedWorkers,
      pendingPromises: this.pendingPromises,
      browserPoolPages: poolWorkers,
      queueSize: this.queue.size(),
      memoryUsage: memory,
      lastDiscoveryTimestamp: this.lastDiscovery,
      lastProcessedTimestamp: this.lastProcessed,
    };
  }

  // Determine if the scheduler is healthy (no blocked workers, no pending promises, empty queue)
  isHealthy() {
    const snap = this.snapshot();
    return (
      snap.workersBlocked === 0 &&
      snap.pendingPromises === 0 &&
      snap.queueSize === 0 &&
      snap.browserPoolPages === 0
    );
  }
}
