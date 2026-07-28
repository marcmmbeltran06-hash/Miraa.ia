import type { BrowserPool } from '@autowp/browser';
import type { EventBus } from '@autowp/event-bus';
import type { Queue } from '@autowp/queue';
import { Buffer } from 'node:buffer';
import { InMemoryQueue } from '@autowp/queue';
import { parseHtml } from '@autowp/html-parser';
import { CrawlResult, CrawlTask, CrawlerOptions } from './types.js';
import { RobotsTxtManager } from './RobotsTxt.js';
import { isSameDomain, normalizeUrl, classifyUrl, UrlCategory, canonicalizeUrl, equivalenceKey, urlPatternKey, contentFingerprint, isAssetUrl, assetTypeFromUrl } from './utils.js';
import type { TerminationDiagnostics, CancelSource } from './TerminationDiagnostics.js';
import { captureStack } from './TerminationDiagnostics.js';
import { StabilityMonitor } from './StabilityMonitor.js';
import { AdaptiveCrawlController } from './AdaptiveCrawlController.js';
import { ShutdownManager } from './ShutdownManager.js';
import * as fs from 'fs';
import { SchedulerHealthMonitor } from './SchedulerHealthMonitor.js';

// Helper to assign priority based on URL category (higher = earlier).
const CATEGORY_PRIORITY: Record<UrlCategory, number> = {
  [UrlCategory.Product]: 100,
  [UrlCategory.Category]: 90,
  [UrlCategory.Collection]: 80,
  [UrlCategory.LandingPage]: 70,
  [UrlCategory.Blog]: 60,
  [UrlCategory.Legal]: 50,
  [UrlCategory.Secondary]: 40,
  [UrlCategory.Unknown]: 10,
  [UrlCategory.Tracking]: 5,
  [UrlCategory.Functional]: 30,
  [UrlCategory.Static]: 20,
};

type BrowserResponse = {
  status?: () => number;
  headers?: () => Record<string, string>;
};

type BrowserPage = {
  goto: (url: string, options?: { timeout?: number; waitUntil?: string }) => Promise<BrowserResponse | null>;
  content: () => Promise<string>;
  screenshot?: (options?: { fullPage?: boolean; type?: 'png' | 'jpeg' }) => Promise<Buffer | Uint8Array | string>;
  setViewportSize?: (viewport: { width: number; height: number }) => Promise<void>;

  evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
};

type BrowserSession = {
  page?: BrowserPage;
};

type CommerceStateCapture = {
  name: 'product' | 'variant-selected' | 'product-added' | 'cart' | 'checkout';
  device: 'desktop' | 'mobile';
  url: string;
  contentType: 'image/png';
  dataBase64: string;
  viewport: { width: number; height: number };
  capturedAt: string;
};

let PATTERN_EXPLOSION_LIMIT = 25;

const DEFAULT_OPTIONS = {
  concurrency: 3,
  strategy: 'bfs' as const,
  maxDepth: 3,
  maxPages: 100,
  timeoutMs: 60_000,
  retryCount: 2,
  retryDelayMs: 500,
  rateLimitMs: 0,
  excludeExternalDomains: true,
  allowedDomains: [] as string[],
  robotsTxtEnabled: false,
  userAgent: 'AutoWP Crawler',
  stagnationLimit: 3,
  stabilityWindowMs: 10_000,
  patternExplosionLimit: 25,
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export class WebCrawler {
  private finished = false; // tracks if crawl has fully completed
  private readonly browserPool: BrowserPool<unknown>;
  private readonly eventBus: EventBus;
  private readonly concurrency: number;
  private readonly strategy: 'bfs' | 'dfs';
  private readonly maxDepth: number; // kept for compatibility, ignored in logic
  private readonly maxPages: number; // kept for compatibility, ignored in logic
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly rateLimitMs: number;
  private readonly stagnationLimit: number;
  private readonly stabilityWindowMs: number;
  private readonly excludeExternalDomains: boolean;
  private readonly allowedHostnames: Set<string>;
  private readonly robotsManager: RobotsTxtManager;
  private readonly queue: Queue<void>;

  private readonly adaptiveController: AdaptiveCrawlController;
  private readonly shutdownManager: ShutdownManager;

  // ----- New metrics & classification members -----
  private readonly visited = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly accepted = new Set<string>();
  private readonly equivalenceSeen = new Set<string>();
  private readonly contentSeen = new Set<string>();
  private readonly frontier: CrawlTask[] = [];
  private cancelled = false;
  private cancelSource?: CancelSource;
  private cancelStack?: string;
  private discoveryPaused = false;
  private startTime = 0;
  private terminationReason?: string;
  private terminationDiagnostics?: TerminationDiagnostics;
  private pendingDiscarded = 0;
  private lastStabilityCheck: number;
  private readonly stabilityMonitor: StabilityMonitor;
  private readonly schedulerHealth: SchedulerHealthMonitor;
  private readonly scheduledTasks: CrawlTask[] = [];
  // Diagnostics structures for detailed analysis
  private readonly pageDuplicateCounts = new Map<string, number>();
  private readonly pageVisitedDuplicateCounts = new Map<string, number>();
  private readonly evolution: { timestamp: number; frontier: number; queue: number }[] = [];
  // Track pattern discovery rates for novelty computation
  private readonly patternDiscoveryWindow: Array<{ timestamp: number; newPatterns: number }> = [];
  private previousTotalPatterns = 0;

  private lastRequest = Promise.resolve();
  private pagesFailed = 0;
  private pagesDiscovered = 0;
  private activeWorkers = 0;

  // metrics counters
  private duplicates = 0;
  private discarded = 0;
  private processed = 0;
  private totalPageTimeMs = 0;
  private lastMetricsEmit = Date.now();
  private metricsTimer?: ReturnType<typeof setInterval>;
  private urlCategoryMap = new Map<string, UrlCategory>();
  // diagnostics structures
  private patternCounts = new Map<string, number>();
  private pageDiscoveryCounts = new Map<string, number>();
  private maxMemory = { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 };
  private commerceStateCaptureClaimed = false;

  // duplicate member definitions removed

  // Event-driven wakeup for the main loop — avoids busy-polling every 100ms.
  private wakeupResolve: (() => void) | null = null;
  private wakeupPromise: Promise<void> | null = null;

  private signalWakeup(): void {
    if (this.wakeupResolve) {
      this.wakeupResolve();
      this.wakeupResolve = null;
      this.wakeupPromise = null;
    }
  }

  private async waitForWakeup(timeoutMs: number): Promise<void> {
    if (!this.wakeupPromise) {
      this.wakeupPromise = new Promise((resolve) => {
        this.wakeupResolve = resolve;
      });
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([this.wakeupPromise, timeout]);
  }

  constructor(private readonly options: CrawlerOptions) {
    this.eventBus = options.eventBus;
    this.browserPool = options.browserPool;
    this.concurrency = options.concurrency ?? DEFAULT_OPTIONS.concurrency;
    this.strategy = options.strategy ?? DEFAULT_OPTIONS.strategy;
    this.maxDepth = options.maxDepth ?? DEFAULT_OPTIONS.maxDepth; // retained but not used for stopping
    this.maxPages = options.maxPages ?? DEFAULT_OPTIONS.maxPages; // retained but not used for stopping
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs;
    this.retryCount = options.retryCount ?? DEFAULT_OPTIONS.retryCount;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_OPTIONS.retryDelayMs;
    this.stagnationLimit = options.stagnationLimit ?? DEFAULT_OPTIONS.stagnationLimit;
    this.stabilityWindowMs = options.stabilityWindowMs ?? DEFAULT_OPTIONS.stabilityWindowMs;
    PATTERN_EXPLOSION_LIMIT = options.patternExplosionLimit ?? DEFAULT_OPTIONS.patternExplosionLimit;
    this.queue = options.queue ?? new InMemoryQueue<void>(this.concurrency);
    this.schedulerHealth = new SchedulerHealthMonitor(this.browserPool, this.queue);
    this.adaptiveController = new AdaptiveCrawlController(this.concurrency);
    this.shutdownManager = new ShutdownManager(
      this.browserPool,
      this.adaptiveController,
      this.queue,
      () => this.frontier.length,
      () => this.scheduledTasks.length,
      () => this.activeWorkers,
    );
    this.stabilityMonitor = new StabilityMonitor(this.stagnationLimit);

    // Use correct rate limit field
    this.lastStabilityCheck = Date.now();
    this.rateLimitMs = options.rateLimitMs ?? DEFAULT_OPTIONS.rateLimitMs;
    this.excludeExternalDomains = options.excludeExternalDomains ?? DEFAULT_OPTIONS.excludeExternalDomains;
    this.allowedHostnames = new Set(
      (options.allowedDomains ?? []).map((domain) => domain.toLowerCase())
    );
    this.robotsManager = new RobotsTxtManager({
      enabled: options.robotsTxtEnabled ?? DEFAULT_OPTIONS.robotsTxtEnabled,
      userAgent: options.userAgent ?? DEFAULT_OPTIONS.userAgent,
    });

    for (const startUrl of options.startUrls) {
      const normalized = normalizeUrl(startUrl, startUrl);
      if (normalized) {
        this.allowedHostnames.add(new URL(normalized).hostname.toLowerCase());
      }
    }
  }

  public async crawl(): Promise<CrawlResult> {
    this.startTime = Date.now();
    // start metrics timer (emit every second)
    this.lastMetricsEmit = Date.now();
    if (process.env.NODE_ENV !== 'test') {
      this.metricsTimer = setInterval(() => this.emitMetrics(), 1000);
    }

    await this.enqueueInitialUrls();
    this.scheduleTasks();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        // If crawl already finished, ignore timeout.
        if (this.finished) {
          return;
        }
        console.warn('Global timeout reached — forcing termination via exhaustion');

        // Force-terminate: stuck workers (e.g. hanging page loads) prevent the
        // StabilityMonitor from detecting exhaustion naturally. The timeout
        // acts as a last-resort circuit breaker that properly completes the
        // crawl without cancelling.
        this.discoveryPaused = true;
        this.pendingDiscarded += this.frontier.length;
        this.frontier.length = 0;
        this.pendingDiscarded += this.scheduledTasks.length;
        this.scheduledTasks.length = 0;
        this.queue.clear();

        this.terminationReason = 'timeout_safety_net';
        this.recordTerminationDecision(
          'timeout_safety_net',
          'crawl.timeout',
          {
            discardJustification:
              'Global timeout reached as a last-resort safety net. ' +
              'Pending and in-flight work were discarded to unblock termination. ' +
              'The StabilityMonitor did not detect exhaustion naturally, likely ' +
              'due to stuck workers or unresponsive pages.',
          },
        );
        // Wake the main loop so it immediately sees terminationReason.
        this.signalWakeup();
      }, this.timeoutMs);
    }

    while (
      this.frontier.length > 0 ||
      this.queue.size() > 0 ||
      this.activeWorkers > 0 ||
      this.adaptiveController.getPendingRetryCount() > 0 ||
      this.adaptiveController.isInCooldown()
    ) {
      await this.waitForWakeup(500);
      this.recordEvolutionSnapshot();

      // Always attempt to schedule — picks up ready retries and respects
      // adaptive concurrency once a worker finishes.
      this.scheduleTasks();

      if (this.cancelled) {
        this.recordTerminationDecision(
          this.cancelSource === 'timeout' ? 'timeout' : 'user_cancelled',
          `cancel(${this.cancelSource ?? 'unknown'})`,
          {
            discardJustification:
              this.cancelSource === 'timeout'
                ? 'Global timeout reached. Queue closed without processing remaining URLs.'
                : 'Explicit cancellation. Queue closed without processing remaining URLs.',
          },
        );
        break;
      }

      // If the safety-net timeout has cleared all pending work, break even if
      // stuck workers remain (they will be discarded on next acquire).
      if (this.terminationReason) {
        break;
      }

      // Do NOT evaluate stability during global cooldown — the crawler is
      // voluntarily waiting, not stuck. Evaluating would falsely detect
      // stagnation and prematurely terminate the crawl.
      const now = Date.now();
      if (
        now - this.lastStabilityCheck >= this.stabilityWindowMs &&
        !this.adaptiveController.isInCooldown()
      ) {
        this.lastStabilityCheck = now;
        const evaluation = this.stabilityMonitor.evaluate(this.captureStabilitySnapshot());

        // pause_discovery: stop discovering new URLs, keep draining the queue.
        // This NEVER terminates the crawl — only discovery is affected.
        if (evaluation.verdict === 'pause_discovery' && !this.discoveryPaused) {
          this.discoveryPaused = true;
          this.recordTerminationDecision(
            evaluation.reason ?? 'knowledge_stagnation',
            'StabilityMonitor.evaluate',
            {
              stabilityEvaluation: evaluation,
              discardJustification:
                'Discovery paused only. Pending URLs remain queued and will be processed. ' +
                'No URLs discarded because they are not proven duplicates or irrelevant.',
            },
          );
        }

        // exhausted: treated exactly like pause_discovery. The crawler keeps
        // running and the queue keeps draining until it reaches zero naturally.
        // The global timeout safety-net is the only circuit-breaker for truly
        // stuck crawls.
        if (evaluation.verdict === 'exhausted' && !this.discoveryPaused) {
          this.discoveryPaused = true;
          console.warn(
            `[Crawler] StabilityMonitor reports exhaustion – keeping discovery paused, ` +
            `queue will continue draining (frontier=${this.frontier.length}, ` +
            `queue=${this.queue.size()}, workers=${this.activeWorkers})`,
          );
        }

        // complete: queue is truly drained — this is the ONLY valid
        // non-cancellation, non-timeout termination.
        if (evaluation.verdict === 'complete') {
          if (this.adaptiveController.hasPendingRetries() || this.adaptiveController.isInCooldown()) {
            continue;
          }
          // Verify we are really done
          if (this.frontier.length > 0 || this.queue.size() > 0 || this.activeWorkers > 0) {
            continue;
          }
          this.terminationReason = evaluation.reason ?? 'queue_drained';
          this.recordTerminationDecision(
            this.terminationReason,
            'StabilityMonitor.evaluate',
            {
              stabilityEvaluation: evaluation,
              discardJustification: 'Queue drained naturally – all pending URLs were processed.',
            },
          );
          break;
        }
      }
    }

    if (!this.terminationReason && !this.cancelled && this.frontier.length === 0 && this.queue.size() === 0) {
      this.terminationReason = 'queue_drained';
      this.recordTerminationDecision('queue_drained', 'crawl.loop_exit', {
        discardJustification: 'Queue drained naturally after main loop exit.',
      });
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    // Mark crawl as finished before cleanup to prevent later timeout cancellation.
    this.finished = true;
    // Close the queue without awaiting to avoid potential deadlock if the queue implementation expects ongoing tasks.
    this.queue.close().catch(() => {});
    // Request shutdown — waits for all workers, retries, and pending tasks to drain,
    // then closes the BrowserPool safely (only when activeWorkers === 0).
    this.shutdownManager.requestShutdown();
    await this.shutdownManager.awaitShutdown();

    // stop metrics timer
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }

    const result = this.buildResult();
    // Write diagnostic file
    const diagnostics = {
      urlsDiscovered: this.pagesDiscovered,
      urlsProcessed: this.processed,
      duplicates: this.duplicates,
      discarded: this.discarded,
      duplicateRatio: this.pagesDiscovered ? this.duplicates / this.pagesDiscovered : 0,
      urlCategories: Object.fromEntries(this.urlCategoryMap),
      maxMemory: this.maxMemory,
      averageSpeedPagesPerSec: this.processed / ((Date.now() - this.startTime) / 1000),
      topPageDiscoveries: Array.from(this.pageDiscoveryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {}),
      pagesGeneratingMostUrls: Array.from(this.pageDiscoveryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {}),
      topUrlPatterns: Array.from(this.patternCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {}),
      pageDuplicateCounts: Object.fromEntries(this.pageDuplicateCounts),
      pageVisitedDuplicateCounts: Object.fromEntries(this.pageVisitedDuplicateCounts),
      pagesRediscoveringUrls: Object.fromEntries(this.pageVisitedDuplicateCounts),
      pendingUrls: this.collectPendingUrlSamples().map((sample) => sample.url),
      termination: this.terminationDiagnostics,
      discoveryPaused: this.discoveryPaused,
      cancelSource: this.cancelSource,
      cancelStack: this.cancelStack,
      stabilityHistory: this.stabilityMonitor.history,
      evolution: this.evolution,
      queueEvolution: this.evolution.map((entry) => entry.queue),
      frontierEvolution: this.evolution.map((entry) => entry.frontier),
    } as const;
    try {
      // Write diagnostics to file using imported fs module
      fs.writeFileSync('crawl-diagnostics.json', JSON.stringify(diagnostics, null, 2));
    } catch (err) {
      console.error('Failed to write crawl diagnostics:', err);
    }
    await this.eventBus.publish({
      type: 'CrawlerFinished',
      payload: result,
    });

    return result;
  }

  public cancel(source: CancelSource = 'user'): void {
    // If crawl already finished, ignore cancellation to preserve completed state.
    if (this.finished) {
      return;
    }
    if (this.cancelled) {
      return;
    }

    this.cancelled = true;
    this.cancelSource = source;
    this.cancelStack = captureStack();
    this.queue.close().catch(() => undefined);
  }

  private buildResult(): CrawlResult {
    return {
      pagesVisited: this.visited.size,
      pagesFailed: this.pagesFailed,
      pagesDiscovered: this.pagesDiscovered,
      durationMs: Date.now() - this.startTime,
      cancelled: this.cancelled,
      duplicates: this.duplicates,
      discarded: this.discarded,
      pendingDiscarded: this.pendingDiscarded,
      terminationReason: this.terminationReason,
      terminationDiagnostics: this.terminationDiagnostics,
      cancelSource: this.cancelSource,
      memoryUsage: process.memoryUsage(),
      diagnostics: this.captureDiagnostics(),
    };
  }

  private captureDiagnostics(): CrawlResult['diagnostics'] {
    return {
      urlCategories: Object.fromEntries(this.urlCategoryMap),
      evolution: this.evolution.slice(-120),
      termination: this.terminationDiagnostics,
      stabilityHistory: this.stabilityMonitor.history.slice(-20),
      pendingUrls: this.collectPendingUrlSamples().map((s) => s.url),
      discoveryPaused: this.discoveryPaused,
      cancelSource: this.cancelSource,
      pageDuplicateCounts: Object.fromEntries(this.pageDuplicateCounts),
      pageVisitedDuplicateCounts: Object.fromEntries(this.pageVisitedDuplicateCounts),
      patternCounts: Object.fromEntries(this.patternCounts),
      maxMemory: { ...this.maxMemory },
    };
  }

  private recordTerminationDecision(
    reason: string,
    invokedBy: string,
    options: {
      stabilityEvaluation?: import('./StabilityMonitor.js').StabilityEvaluation;
      discardJustification?: string;
    } = {},
  ): void {
    const pending = this.collectPendingCounts();
    this.terminationReason = reason;
    this.terminationDiagnostics = {
      timestamp: Date.now(),
      reason,
      invokedBy,
      cancelSource: this.cancelSource,
      cancelStack: this.cancelStack,
      pendingAtDecision: pending,
      pendingDiscarded: this.pendingDiscarded,
      discardJustification: options.discardJustification,
      stabilityEvaluation: options.stabilityEvaluation,
      metricsAtDecision: {
        ...this.captureStabilitySnapshot(),
        pagesVisited: this.visited.size,
        duplicates: this.duplicates,
        discarded: this.discarded,
        discoveryPaused: this.discoveryPaused,
      },
      pendingUrlSamples: this.collectPendingUrlSamples(),
      stabilityHistory: this.stabilityMonitor.history.slice(-10),
    };

    if (process.env.NODE_ENV !== 'test') {
      console.error(
        `[CrawlerTermination] reason=${reason} invokedBy=${invokedBy} ` +
          `pending=${pending.total} (frontier=${pending.frontier}, queue=${pending.queue}) ` +
          `discarded=${this.pendingDiscarded} justification="${options.discardJustification ?? ''}"`,
      );
      if (options.stabilityEvaluation) {
        console.error(
          `[CrawlerTermination] stability: ${options.stabilityEvaluation.justification}`,
        );
      }
    }
  }

  private collectPendingCounts() {
    return {
      frontier: this.frontier.length,
      queue: this.queue.size(),
      total: this.frontier.length + this.queue.size(),
    };
  }

  /**
   * Count pending, not-yet-started navigable knowledge URLs.
   *
   * Assets never enter the frontier (filtered in processPage and enqueueUrl),
   * but we re-check defensively so a stray asset URL can never be mistaken for
   * pending knowledge and block completion.
   *
   * We also skip URLs whose canonical address is already in `visited` — they
   * were already processed (and their content fingerprinted) so they add no
   * new knowledge.
   */
  private countPendingKnowledge(): number {
    let count = 0;
    for (const task of this.frontier) {
      if (isAssetUrl(task.url)) continue;
      if (this.visited.has(task.url)) continue;
      count += 1;
    }
    for (const task of this.scheduledTasks) {
      if (isAssetUrl(task.url)) continue;
      if (this.visited.has(task.url)) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Timeout fired but no navigable knowledge is pending. Stop new discovery,
   * discard any leftover non-knowledge pending work (frontier + scheduled) and
   * clear non-started queue tasks so the main loop exits promptly.
   *
   * Any in-flight worker finishes on its own; with discovery paused and no
   * pending tasks the main loop drains in seconds.
   */
  private finalizeKnowledgeCompleteOnTimeout(): void {
    this.discoveryPaused = true;

    // Discard all not-yet-started work — only assets / equivalents remain.
    this.pendingDiscarded += this.frontier.length;
    this.frontier.length = 0;
    this.pendingDiscarded += this.scheduledTasks.length;
    this.scheduledTasks.length = 0;

    // Reject pending (non-started) queue tasks so they never consume workers.
    this.queue.clear();

    this.recordTerminationDecision('timeout_knowledge_complete', 'crawl.timeout', {
      discardJustification:
        'Global timeout reached with no navigable knowledge URLs pending. ' +
        'Remaining pending URLs were assets or equivalent duplicates and were discarded. ' +
        'Crawl finalized as completed without cancelling.',
    });
  }

  private collectPendingUrlSamples() {
    const samples = [
      ...this.frontier.map((task) => ({
        url: task.url,
        depth: task.depth,
        priority: task.priority,
        sourceUrl: task.sourceUrl,
        classification: 'frontier' as const,
      })),
      ...this.scheduledTasks.map((task) => ({
        url: task.url,
        depth: task.depth,
        priority: task.priority,
        sourceUrl: task.sourceUrl,
        classification: 'queued' as const,
      })),
    ];
    return samples.slice(0, 50);
  }

  private recordEvolutionSnapshot(): void {
    this.evolution.push({
      timestamp: Date.now(),
      frontier: this.frontier.length,
      queue: this.queue.size(),
    });
  }

  private captureStabilitySnapshot() {
    const memory = process.memoryUsage();
    // Compute novelty: ratio of new patterns discovered in recent windows
    const now = Date.now();
    this.patternDiscoveryWindow.push({ timestamp: now, newPatterns: this.patternCounts.size - this.previousTotalPatterns });
    this.previousTotalPatterns = this.patternCounts.size;
    // Keep only the last 5 stability windows of data
    const windowStart = now - this.stabilityWindowMs * 5;
    while (this.patternDiscoveryWindow.length > 0 && this.patternDiscoveryWindow[0].timestamp < windowStart) {
      this.patternDiscoveryWindow.shift();
    }
    const recentNewPatterns = this.patternDiscoveryWindow.reduce((sum, w) => sum + w.newPatterns, 0);
    const totalRecent = this.patternDiscoveryWindow.length;
    const discoveryNovelty = totalRecent > 0 ? recentNewPatterns / totalRecent : 0;
    return {
      queueSize: this.frontier.length + this.queue.size(),
      knowledgeSize: this.accepted.size,
      discovered: this.pagesDiscovered,
      processed: this.processed,
      memoryRss: memory.rss,
      activeWorkers: this.activeWorkers,
      pendingKnowledge: this.countPendingKnowledge(),
      discoveryNovelty,
    };
  }


  private async enqueueInitialUrls(): Promise<void> {
    for (const url of this.options.startUrls) {
      console.error(`[enqueueInitial] Adding start URL ${url}`);
      await this.enqueueUrl(url, 0);
    }
  }

  private async enqueueUrl(url: string, depth: number, sourceUrl?: string): Promise<boolean> {
    if (this.cancelled) {
      return false;
    }
    if (this.discoveryPaused && sourceUrl !== undefined) {
      return false;
    }
    const normalized = normalizeUrl(url, sourceUrl ?? url);
    if (!normalized) {
      // URL rejected by normalisation => discarded
      this.discarded++;
      console.error(`[enqueueUrl] Discarded (normalization) ${url}`);
      return false;
    }

    // Safety net: reject asset URLs that bypassed the processPage filter
    // (e.g. start URLs, redirected URLs, or URLs arriving from non-HTTP paths).
    if (isAssetUrl(normalized)) {
      await this.eventBus.publish({
        type: 'AssetFound',
        payload: { url: normalized, pageUrl: sourceUrl ?? normalized, type: assetTypeFromUrl(normalized) },
      });
      return false;
    }

    // Duplicate detection (canonical URL already accepted)
    const canonical = canonicalizeUrl(normalized);
    if (this.accepted.has(canonical)) {
      this.duplicates++;
      if (sourceUrl) {
        const dup = this.pageDuplicateCounts.get(sourceUrl) ?? 0;
        this.pageDuplicateCounts.set(sourceUrl, dup + 1);
        if (this.visited.has(canonical)) {
          const visDup = this.pageVisitedDuplicateCounts.get(sourceUrl) ?? 0;
          this.pageVisitedDuplicateCounts.set(sourceUrl, visDup + 1);
        }
      }
      return false;
    }

    const equivalent = equivalenceKey(normalized);
    if (this.equivalenceSeen.has(equivalent)) {
      this.duplicates++;
      return false;
    }

    const pattern = urlPatternKey(normalized);
    const patternCount = this.patternCounts.get(pattern) ?? 0;
    if (patternCount >= PATTERN_EXPLOSION_LIMIT) {
      this.duplicates++;
      return false;
    }

    if (this.excludeExternalDomains && !this.isAllowedDomain(normalized)) {
      this.discarded++;
      console.error(`[enqueueUrl] Disallowed domain ${normalized}`);
      return false;
    }

    if (!(await this.robotsManager.allows(normalized))) {
      this.discarded++;
      console.error(`[enqueueUrl] Robots.txt disallows ${normalized}`);
      return false;
    }

    // Classification – store category for later reporting
    const category = classifyUrl(normalized);
    this.urlCategoryMap.set(normalized, category);
    this.queued.add(canonical);
    this.accepted.add(canonical);
    this.equivalenceSeen.add(equivalent);
    this.pagesDiscovered += 1;

    const basePriority = CATEGORY_PRIORITY[category] ?? 0;
    const priority = this.adaptiveController.adjustPriority(basePriority, normalized, category);
    const task: CrawlTask = { url: canonical, depth, sourceUrl, priority };
    this.frontier[this.strategy === 'dfs' ? 'unshift' : 'push'](task);
    this.patternCounts.set(pattern, patternCount + 1);
    // Record discovery count per page
    if (sourceUrl) {
      const prev = this.pageDiscoveryCounts.get(sourceUrl) ?? 0;
      this.pageDiscoveryCounts.set(sourceUrl, prev + 1);
    }

    await this.eventBus.publish({
      type: 'PageDiscovered',
      payload: { url: canonical, depth, sourceUrl },
    });

    this.scheduleTasks();
    this.signalWakeup();
    return true;
  }

  private scheduleTasks(): void {
    // Pick up ready retries from adaptive controller's retry queue
    const readyRetries = this.adaptiveController.getDelayedRetries();
    for (const retry of readyRetries) {
      this.frontier.push({
        url: retry.url,
        depth: retry.depth,
        sourceUrl: retry.sourceUrl,
        priority: 100,
      });
    }

    this.frontier.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const effectiveConcurrency = this.adaptiveController.getConcurrency();
    while (!this.cancelled && this.frontier.length > 0) {
      if (this.activeWorkers >= effectiveConcurrency) break;
      const task = this.frontier.shift() as CrawlTask;
      this.scheduledTasks.push(task);
      this.queue.enqueue(() => this.safeProcessTask(task)).catch(() => {
        // Task was discarded (e.g. queue cleared after timeout knowledge complete).
      });
    }
    if (process.env.NODE_ENV !== 'test') {
      this.emitMetrics();
    }
  }

  private async safeProcessTask(task: CrawlTask): Promise<void> {
    if (this.cancelled) {
      return;
    }

    // Staggered start for adaptive mode
    const staggerDelay = this.adaptiveController.getStaggerDelay(this.activeWorkers);
    if (staggerDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerDelay));
    }

    this.activeWorkers += 1;
    this.schedulerHealth.workerStarted();
    this.queued.delete(task.url);
    this.visited.add(task.url);
    this.schedulerHealth.incPending();
    const scheduledIdx = this.scheduledTasks.findIndex((t) => t.url === task.url);
    if (scheduledIdx >= 0) {
      this.scheduledTasks.splice(scheduledIdx, 1);
    }

    try {
      const start = Date.now();
      let attempt = 1;
      const maxAttempts = this.retryCount + 3; // e.g. 5 for default retryCount=2
      while (attempt <= maxAttempts && !this.cancelled) {
        try {
          await this.processPage(task);
          this.adaptiveController.onSuccess();
          this.adaptiveController.removeRetry(task.url);
          break;
        } catch (error) {
          const err = error as Error & { isRateLimit?: boolean; statusCode?: number; retryAfterSec?: number };

          if (err.isRateLimit) {
            this.adaptiveController.onRateLimit(err.retryAfterSec);
            console.warn(
              `[AdaptiveCrawl] Rate limited (429) ${task.url} — attempt ${attempt}/${maxAttempts}`,
            );

            if (attempt < maxAttempts) {
              const enqueued = this.adaptiveController.enqueueRetry(
                task.url,
                task.depth,
                task.sourceUrl,
                maxAttempts,
              );
              this.scheduleTasks();
              this.signalWakeup();
              if (enqueued) {
                return; // Will be retried via retry queue
              }
              // enqueueRetry returned false — too many retries, fall through to failure
            }
          } else {
            attempt++;
            if (attempt <= maxAttempts) {
              console.warn(
                `[Crawler] Error processing ${task.url} (attempt ${attempt - 1}/${maxAttempts}): ${err.message}`,
              );
              await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
              continue;
            }
          }

          // All retries exhausted — mark as failed
          this.pagesFailed += 1;
          this.adaptiveController.removeRetry(task.url);
          this.schedulerHealth.decPending();
          await this.eventBus.publish({
            type: 'PageFailed',
            payload: {
              url: task.url,
              depth: task.depth,
              attempt: maxAttempts,
              error: err.message,
            },
          });
        }
      }
      const elapsed = Date.now() - start;
      const mem = process.memoryUsage();
      this.maxMemory.heapUsed = Math.max(this.maxMemory.heapUsed, mem.heapUsed);
      this.maxMemory.heapTotal = Math.max(this.maxMemory.heapTotal, mem.heapTotal);
      this.maxMemory.rss = Math.max(this.maxMemory.rss, mem.rss);
      this.maxMemory.external = Math.max(this.maxMemory.external, mem.external);
      this.totalPageTimeMs += elapsed;
      this.processed++;

      if (process.env.NODE_ENV !== 'test') {
        this.emitMetrics();
      }

      this.scheduleTasks();
      this.signalWakeup();
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.schedulerHealth.workerFinished();
      this.signalWakeup();
    }
  }

  private async processPage(task: CrawlTask): Promise<void> {
    await this.applyRateLimit();

    const session = await this.browserPool.acquire();
    let sessionReleased = false;

    try {
      const page = (session as BrowserSession).page;
      if (!page || typeof page.goto !== 'function') {
        await this.browserPool.release(session);
        sessionReleased = true;
        throw new Error('Browser session does not expose a Page object');
      }
      const start = Date.now();
      const gotoTimeout = Math.min(this.timeoutMs, 30_000);
      const response = await withTimeout(
        page.goto(task.url, {
          timeout: gotoTimeout,
          waitUntil: 'domcontentloaded',
        }),
        gotoTimeout + 2_000,
        'Page navigation timed out',
      );
      const durationMs = Date.now() - start;
      const status = typeof response?.status === 'function' ? response.status() : 0;

      // Rate limit (429) handling: throw a typed error for safeProcessTask to backoff
      if (status === 429) {
        let retryAfterSec: number | undefined;
        if (typeof response?.headers === 'function') {
          const headers = response.headers();
          const raw = headers?.['retry-after'];
          if (raw !== undefined) {
            retryAfterSec = parseInt(raw, 10);
            if (isNaN(retryAfterSec)) retryAfterSec = 10;
            console.log(`[AdaptiveCrawl] Retry-After header: ${raw}s`);
          }
        }
        throw Object.assign(new Error(`Rate limited (429): ${task.url}`), {
          isRateLimit: true,
          statusCode: 429,
          retryAfterSec,
        });
      }

      await this.eventBus.publish({
        type: 'PageVisited',
        payload: {
          url: task.url,
          depth: task.depth,
          status,
          durationMs,
        },
      });

      // Load lazy/infinite-scroll content before capturing the DOM snapshot.
      await this.autoScroll(page);

      let screenshot: {
        contentType: 'image/png';
        dataBase64: string;
        viewport?: { width: number; height: number };
        fullPage: boolean;
        capturedAt: string;
        commerceStates?: CommerceStateCapture[];
        commerceCaptureStatus?: 'captured' | 'not-product' | 'blocked' | 'partial' | 'failed';
        commerceCaptureIssues?: string[];
      } | undefined;
      if (typeof page.screenshot === 'function') {
        try {
          // Visual references must be deterministic. Animated CSS, carousels and
          // videos otherwise produce a different frame when WordPress is later
          // validated, making a faithful reconstruction look unrelated.
          await page.evaluate(() => {
            document.getElementById('autowp-visual-freeze')?.remove();
            const style = document.createElement('style');
            style.id = 'autowp-visual-freeze';
            style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
            document.head.appendChild(style);
            window.scrollTo(0, 0);
            for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))) {
              try {
                media.pause();
                media.currentTime = 0;
              } catch { /* cross-origin/stream media may not be seekable */ }
            }
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const [image, viewport] = await Promise.all([
            page.screenshot({ fullPage: true, type: 'png' }),
            page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
          ]);
          await page.evaluate(() => document.getElementById('autowp-visual-freeze')?.remove());
          screenshot = {
            contentType: 'image/png',
            dataBase64: Buffer.from(image as Uint8Array).toString('base64'),
            viewport,
            fullPage: true,
            capturedAt: new Date().toISOString(),
          };
        } catch {
          screenshot = undefined;
        }
      }

      const html = await page.content();
      this.adaptiveController.detectShopify(html);
      const parse = parseHtml(html, task.url);

      const resolvedCanonical = parse.canonical ? canonicalizeUrl(parse.canonical) : task.url;
      const fingerprint = contentFingerprint(parse.title, resolvedCanonical, parse.internalLinks.length);
      if (this.contentSeen.has(fingerprint)) {
        this.duplicates++;
        return;
      }
      this.contentSeen.add(fingerprint);

      // ----- Extract full page text content -----
      let pageContent: string | undefined;
      try {
        pageContent = await page.evaluate(() => document.body?.innerText ?? '');
      } catch {
        pageContent = undefined;
      }
      // -----------------------------------------

      // ----- Extract computed styles for layout sections -----
      let computedStyles: Array<{ selector: string; styles: Record<string, string> }> | undefined;
      try {
        computedStyles = await page.evaluate(() => {
          const sectionSelector = 'main > section, main > article, body > section, body > article, [class*="section"], [class*="hero"], [class*="banner"], [class*="container"], [class*="wrapper"]';
          const elements = document.querySelectorAll(sectionSelector);
          const results: Array<{ selector: string; styles: Record<string, string> }> = [];
          const computedProps = [
            'display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
            'grid-template-columns', 'grid-template-rows', 'gap', 'padding', 'margin',
            'width', 'max-width', 'min-width', 'height', 'min-height',
            'background-color', 'background-image', 'background-size',
            'font-family', 'font-size', 'font-weight', 'line-height', 'color',
            'text-align', 'border-radius', 'box-shadow', 'position', 'z-index',
            'overflow',
          ];
          for (const el of elements) {
            if (elements.length > 80) break; // Safety limit
            const tag = el.tagName.toLowerCase();
            const cls = el.className?.toString()?.slice(0, 100) ?? '';
            const id = el.id ?? '';
            const selector = `${tag}${id ? '#' + id : ''}.${(cls.split(/\s+/).slice(0, 3).join('.'))}`;
            const computed = window.getComputedStyle(el);
            const styles: Record<string, string> = {};
            for (const prop of computedProps) {
              const val = computed.getPropertyValue(prop);
              if (val && val !== 'none' && val !== 'normal' && val !== '0px' && !val.includes('initial')) {
                styles[prop] = val.slice(0, 200);
              }
            }
            if (Object.keys(styles).length > 0) {
              results.push({ selector, styles });
            }
          }
          return results;
        });
      } catch {
        computedStyles = undefined;
      }
      // -----------------------------------------

      // Capture one representative commerce journey per crawl. Capturing every
      // product would multiply storage by the catalog size and is unnecessary
      // for validating the shared product/cart/checkout templates.
      if (screenshot && !this.commerceStateCaptureClaimed) {
        let isProductSurface = false;
        let captureBlocked = false;
        try {
          const commerceProbe = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const blocked = /(?:captcha|verify you are human|comprueba que eres humano|cloudflare ray id|access denied)/i.test(bodyText) ||
              Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="challenge"], [class*="captcha"], [id*="captcha"]'));
            const product = Boolean(document.querySelector(
              'form[action*="/cart/add"], form.cart, .product-form, [itemtype*="Product"], [data-product-id], button[name="add-to-cart"], .single_add_to_cart_button'
            )) || Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((node) =>
              /"@type"\s*:\s*"Product"/i.test(node.textContent || '')
            );
            return { product, blocked };
          });
          isProductSurface = commerceProbe.product;
          captureBlocked = commerceProbe.blocked;
        } catch { /* state capture is supplementary to the canonical crawl */ }

        if (isProductSurface) {
          this.commerceStateCaptureClaimed = true;
          if (captureBlocked) {
            screenshot.commerceCaptureStatus = 'blocked';
            screenshot.commerceCaptureIssues = ['source-commerce-capture-blocked-by-challenge'];
          } else {
            const captured = await this.captureCommerceStates(page, task.url);
            screenshot.commerceStates = captured.states;
            screenshot.commerceCaptureStatus = captured.status;
            screenshot.commerceCaptureIssues = captured.issues;
          }
        }
      }

      await this.eventBus.publish({
        type: 'PageParsed',
        payload: {
          url: task.url,
          depth: task.depth,
          parse,
          pageContent,
          computedStyles,
          screenshot,
        },
      });

      for (const imageUrl of parse.images) {
        await this.eventBus.publish({
          type: 'AssetFound',
          payload: {
            url: imageUrl,
            pageUrl: task.url,
            type: 'image',
          },
        });
      }

      for (const scriptUrl of parse.scripts) {
        await this.eventBus.publish({
          type: 'AssetFound',
          payload: {
            url: scriptUrl,
            pageUrl: task.url,
            type: 'script',
          },
        });
      }

      for (const stylesheetUrl of parse.stylesheets) {
        await this.eventBus.publish({
          type: 'AssetFound',
          payload: {
            url: stylesheetUrl,
            pageUrl: task.url,
            type: 'stylesheet',
          },
        });
      }

      // Count discovered URLs for this page
      let discoveredCount = 0;
      for (const link of parse.internalLinks) {
        // Asset links (images, css, js, fonts, media, documents, CDN blobs)
        // are NOT knowledge: register them as resources of the source page and
        // never let them consume a crawler worker or block finalization.
        if (isAssetUrl(link)) {
          await this.eventBus.publish({
            type: 'AssetFound',
            payload: { url: link, pageUrl: task.url, type: assetTypeFromUrl(link) },
          });
          continue;
        }
        const added = await this.enqueueUrl(link, task.depth + 1, task.url);
        if (added) discoveredCount++;
      }
      // Store per-page discovery count
      if (discoveredCount > 0) {
        const prev = this.pageDiscoveryCounts.get(task.url) ?? 0;
        this.pageDiscoveryCounts.set(task.url, prev + discoveredCount);
      }
      // Log explosions (>100 new URLs)
      if (discoveredCount > 100) {
        await this.eventBus.publish({
          type: 'UrlExplosion',
          payload: { page: task.url, discovered: discoveredCount },
        });
      }
    } finally {
      if (!sessionReleased) {
        await this.browserPool.release(session);
      }
    }
  }

  // ----- Metrics & Classification helpers -----
  private emitMetrics() {
    const now = Date.now();
    const elapsedSec = (now - this.lastMetricsEmit) / 1000;
    if (elapsedSec <= 0) return;
    const discoveredPerSec = this.pagesDiscovered / ((now - this.startTime) / 1000);
    const processedPerSec = this.processed / ((now - this.startTime) / 1000);
    // avgPageTimeMs retained for potential future use
    const _avgPageTimeMs = this.processed ? this.totalPageTimeMs / this.processed : 0;
    const memory = process.memoryUsage();
    // Update max memory
    this.maxMemory.heapUsed = Math.max(this.maxMemory.heapUsed, memory.heapUsed);
    this.maxMemory.heapTotal = Math.max(this.maxMemory.heapTotal, memory.heapTotal);
    this.maxMemory.rss = Math.max(this.maxMemory.rss, memory.rss);
    this.maxMemory.external = Math.max(this.maxMemory.external, memory.external);
    const categoriesCount: Record<string, number> = {};
    for (const cat of this.urlCategoryMap.values()) {
      const key = cat as string;
      categoriesCount[key] = (categoriesCount[key] ?? 0) + 1;
    }
    const topPatterns = Array.from(this.patternCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});
    this.eventBus.publish({
      type: 'CrawlerMetrics',
      payload: {
        timestamp: now,
        pagesVisited: this.visited.size,
        pagesDiscovered: this.pagesDiscovered,
        frontierLength: this.frontier.length,
        queueSize: this.queue.size(),
        processed: this.processed,
        duplicates: this.duplicates,
        discarded: this.discarded,
        categoriesCount,
        pagesPerSec: processedPerSec,
        newUrlsPerSec: discoveredPerSec,
        memory,
        maxMemory: this.maxMemory,
        topPatterns,
      },
    }).catch(() => {});
    this.lastMetricsEmit = now;
  }



  // Simple auto‑scroll that keeps scrolling until the scroll height stops changing.
  private async autoScroll(page: BrowserPage): Promise<void> {
    try {
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          let lastHeight = 0;
          let stableTicks = 0;
          let steps = 0;
          const started = Date.now();
          const maxSteps = 24;
          const maxMs = 12_000;
          const step = () => {
            if (steps >= maxSteps || Date.now() - started >= maxMs) {
              resolve();
              return;
            }
            steps += 1;
            window.scrollBy(0, window.innerHeight);
            const newHeight = document.body.scrollHeight;
            if (newHeight === lastHeight) {
              stableTicks += 1;
              if (stableTicks >= 2) {
                resolve();
                return;
              }
            } else {
              stableTicks = 0;
            }
            lastHeight = newHeight;
            setTimeout(step, 500);
          };
          step();
        });
      });
    } catch (_) {
      // If the page does not support evaluate or any error occurs, ignore – infinite scroll is optional.
    }
  }

  private async captureCommerceStates(
    page: BrowserPage,
    productUrl: string,
  ): Promise<{
    status: 'captured' | 'partial' | 'failed';
    issues: string[];
    states: CommerceStateCapture[];
  }> {
    const states: CommerceStateCapture[] = [];
    const issues: string[] = [];
    if (typeof page.screenshot !== 'function') return { status: 'failed', issues: ['screenshot-api-unavailable'], states };

    const wait = async (ms = 800): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    };
    const capture = async (
      name: 'product' | 'variant-selected' | 'product-added' | 'cart' | 'checkout',
      device: 'desktop' | 'mobile',
    ): Promise<void> => {
      const [image, viewport, url] = await Promise.all([
        page.screenshot!({ fullPage: false, type: 'png' }),
        page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
        page.evaluate(() => location.href),
      ]);
      states.push({
        name,
        device,
        url,
        contentType: 'image/png',
        dataBase64: Buffer.from(image as Uint8Array).toString('base64'),
        viewport,
        capturedAt: new Date().toISOString(),
      });
    };
    const selectVariant = async (): Promise<boolean> => page.evaluate(() => {
      let changed = false;
      for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>(
        'form.variations_form select, form[action*="/cart/add"] select, select[name^="attribute_"], select[name*="option"]'
      ))) {
        const option = Array.from(select.options).find((candidate) => candidate.value && !candidate.disabled);
        if (!option) continue;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        changed = true;
      }
      if (!changed) {
        const option = document.querySelector<HTMLElement>(
          '[data-option-value]:not([aria-disabled="true"]), [data-variant]:not([aria-disabled="true"]), input[type="radio"][name*="option"]:not(:disabled)'
        );
        option?.click();
        changed = Boolean(option);
      }
      return changed;
    });
    const addProduct = async (): Promise<boolean> => page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(
        'form[action*="/cart/add"] button[type="submit"], form.cart button[type="submit"], button[name="add-to-cart"], .single_add_to_cart_button, [data-add-to-cart]'
      );
      if (!button || button.matches(':disabled,[aria-disabled="true"]')) return false;
      button.click();
      return true;
    });
    const commerceLink = async (kind: 'cart' | 'checkout'): Promise<string | undefined> => {
      const patterns = {
        cart: /(?:^|\/)(?:cart|carrito|cistella|basket|panier|warenkorb)(?:\/|$)/i,
        checkout: /(?:^|\/)(?:checkout|finalizar-compra|finalitzar-compra|pago|pagament|caisse|kasse)(?:\/|$)/i,
      };
      const links = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((anchor) => anchor.href));
      return links.find((href) => {
        try {
          const parsed = new URL(href);
          return parsed.origin === new URL(productUrl).origin && patterns[kind].test(parsed.pathname);
        } catch { return false; }
      });
    };

    for (const device of ['desktop', 'mobile'] as const) {
      try {
        if (page.setViewportSize) {
          await page.setViewportSize(device === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
        }
        await page.goto(productUrl, { timeout: 60_000, waitUntil: 'domcontentloaded' });
        await wait();
        await capture('product', device);
        if (await selectVariant()) {
          await wait();
          await capture('variant-selected', device);
        } else {
          issues.push(`${device}:variant-control-not-found`);
        }
        if (await addProduct()) {
          await wait(1_200);
          await capture('product-added', device);
        } else {
          issues.push(`${device}:add-to-cart-not-usable`);
        }
        const cartUrl = await commerceLink('cart');
        if (cartUrl) {
          await page.goto(cartUrl, { timeout: 60_000, waitUntil: 'domcontentloaded' });
          await wait();
          await capture('cart', device);
          const checkoutUrl = await commerceLink('checkout');
          if (checkoutUrl) {
            await page.goto(checkoutUrl, { timeout: 60_000, waitUntil: 'domcontentloaded' });
            await wait();
            await capture('checkout', device);
          } else {
            issues.push(`${device}:checkout-link-not-found`);
          }
        } else {
          issues.push(`${device}:cart-link-not-found`);
        }
      } catch (error) {
        issues.push(`${device}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      status: states.length >= 8 && !issues.some((issue) => issue.includes('add-to-cart-not-usable')) ? 'captured' : states.length ? 'partial' : 'failed',
      issues,
      states,
    };
  }

  private async applyRateLimit(): Promise<void> {
    // Global cooldown — pause completely if too many rate limits hit recently
    if (this.adaptiveController.isInCooldown()) {
      const remaining = this.adaptiveController.getGlobalCooldownRemainingMs();
      console.log(`[AdaptiveCrawl] Global cooldown active — waiting ${Math.round(remaining / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }

    // Fixed rate limit between requests
    if (this.rateLimitMs > 0) {
      const delay = this.rateLimitMs;
      this.lastRequest = this.lastRequest.then(
        () => new Promise<void>((resolve) => setTimeout(resolve, delay))
      );
      await this.lastRequest;
    }

    // Human-like jitter after the rate-limit wait
    const jitterMs = this.adaptiveController.getJitterMs();
    if (jitterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
  }

  private isAllowedDomain(url: string): boolean {
    if (this.allowedHostnames.size > 0) {
      return isSameDomain(url, this.allowedHostnames);
    }

    return isSameDomain(url, this.allowedHostnames);
  }
}
