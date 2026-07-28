export interface RateLimitMetrics {
  totalRateLimits: number;
  currentConcurrency: number;
  baseConcurrency: number;
  isShopify: boolean;
  adaptiveMode: boolean;
  globalCooldown: boolean;
  globalCooldownRemainingMs: number;
  pendingRateLimited: number;
}

export interface PendingRetry {
  url: string;
  depth: number;
  sourceUrl?: string;
  nextAttemptAt: number;
  attempt: number;
  maxAttempts: number;
}

export class AdaptiveCrawlController {
  private currentConcurrencyVal: number;
  private readonly baseConcurrency: number;
  private detectedShopify = false;
  private adaptiveMode = false;
  private totalRateLimits = 0;
  private consecutiveRateLimits = 0;
  private recentRateLimitTimestamps: number[] = [];
  private successesSinceRateLimit = 0;
  private globalCooldownUntil = 0;
  private readonly cooldownTriggerThreshold = 10;
  private readonly cooldownDurationMs = 45_000;
  private currentBackoffStep = -1;
  private readonly backoffSteps = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
  private readonly successesToRestore = 3;
  private readonly pendingRetries: PendingRetry[] = [];
  private readonly retryCountMap = new Map<string, number>();

  constructor(baseConcurrency: number) {
    this.baseConcurrency = baseConcurrency;
    this.currentConcurrencyVal = baseConcurrency;
  }

  /* ------------------------------------------------------------------ */
  /*  Shopify detection                                                  */
  /* ------------------------------------------------------------------ */

  detectShopify(pageSource: string): boolean {
    if (this.detectedShopify) return true;
    const indicators = [
      '/cdn/shop/',
      'Shopify.theme',
      'window.Shopify',
      'shopify-payment-button',
      'shopify.com',
      'myshopify.com',
    ];
    const found = indicators.some((ind) => pageSource.includes(ind));
    if (found && !this.detectedShopify) {
      this.detectedShopify = true;
      this.adaptiveMode = true;
      console.log('[AdaptiveCrawl] Shopify detected — adaptive mode enabled');
      console.log(`[AdaptiveCrawl] Workers: ${this.currentConcurrencyVal}`);
    }
    return found;
  }

  /* ------------------------------------------------------------------ */
  /*  Rate limit handling                                                */
  /* ------------------------------------------------------------------ */

  onRateLimit(retryAfterSec?: number): void {
    this.totalRateLimits++;
    this.consecutiveRateLimits++;
    this.successesSinceRateLimit = 0;
    this.recentRateLimitTimestamps.push(Date.now());
    this.recentRateLimitTimestamps = this.recentRateLimitTimestamps.filter(
      (t) => Date.now() - t < 30_000,
    );
    const old = this.currentConcurrencyVal;
    if (this.adaptiveMode) {
      this.currentConcurrencyVal = Math.max(1, Math.floor(this.currentConcurrencyVal * 0.5));
    } else {
      this.currentConcurrencyVal = Math.max(1, this.currentConcurrencyVal - 1);
    }
    if (old !== this.currentConcurrencyVal) {
      console.log(`[AdaptiveCrawl] Workers: ${old} → ${this.currentConcurrencyVal}`);
    }
    if (retryAfterSec === undefined || retryAfterSec <= 0) {
      this.currentBackoffStep = Math.min(this.currentBackoffStep + 1, this.backoffSteps.length - 1);
    }
    if (this.recentRateLimitTimestamps.length >= this.cooldownTriggerThreshold) {
      this.triggerGlobalCooldown();
    }
  }

  private triggerGlobalCooldown(): void {
    if (Date.now() < this.globalCooldownUntil) return;
    const duration = this.adaptiveMode
      ? Math.round(this.cooldownDurationMs * 1.5)
      : this.cooldownDurationMs;
    this.globalCooldownUntil = Date.now() + duration;
    console.log(`[AdaptiveCrawl] Global cooldown: ${Math.round(duration / 1000)}s`);
  }

  onSuccess(): void {
    this.successesSinceRateLimit++;
    this.consecutiveRateLimits = 0;
    if (
      this.adaptiveMode &&
      this.successesSinceRateLimit >= this.successesToRestore &&
      this.currentConcurrencyVal < this.baseConcurrency &&
      !this.isInCooldown()
    ) {
      this.currentConcurrencyVal = Math.min(
        this.baseConcurrency,
        this.currentConcurrencyVal + 1,
      );
      console.log(`[AdaptiveCrawl] Workers restored: ${this.currentConcurrencyVal}`);
    }
    if (
      this.currentBackoffStep > 0 &&
      this.consecutiveRateLimits === 0 &&
      this.successesSinceRateLimit >= this.successesToRestore * 2
    ) {
      this.currentBackoffStep = Math.max(0, this.currentBackoffStep - 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Retry management                                                   */
  /* ------------------------------------------------------------------ */

  enqueueRetry(url: string, depth: number, sourceUrl: string | undefined, maxAttempts: number): boolean {
    const currentCount = (this.retryCountMap.get(url) ?? 0) + 1;
    if (currentCount > maxAttempts) {
      this.retryCountMap.delete(url);
      return false;
    }
    this.retryCountMap.set(url, currentCount);
    this.pendingRetries.push({
      url,
      depth,
      sourceUrl,
      nextAttemptAt: Date.now() + this.getDelayForAttempt(currentCount),
      attempt: currentCount,
      maxAttempts,
    });
    this.currentBackoffStep = Math.min(this.currentBackoffStep + 1, this.backoffSteps.length - 1);
    return true;
  }

  getDelayedRetries(): PendingRetry[] {
    const now = Date.now();
    const ready: PendingRetry[] = [];
    for (let i = this.pendingRetries.length - 1; i >= 0; i--) {
      if (this.pendingRetries[i].nextAttemptAt <= now) {
        ready.push(this.pendingRetries[i]);
        this.pendingRetries.splice(i, 1);
      }
    }
    return ready;
  }

  getDelayForAttempt(attempt: number): number {
    const stepIndex = Math.min(attempt - 1, this.backoffSteps.length - 1);
    return this.backoffSteps[stepIndex];
  }

  removeRetry(url: string): void {
    this.retryCountMap.delete(url);
    const idx = this.pendingRetries.findIndex((r) => r.url === url);
    if (idx >= 0) this.pendingRetries.splice(idx, 1);
  }

  /* ------------------------------------------------------------------ */
  /*  Human-like pacing                                                  */
  /* ------------------------------------------------------------------ */

  getJitterMs(): number {
    if (!this.adaptiveMode && this.consecutiveRateLimits === 0) return 0;
    if (this.consecutiveRateLimits > 0) return 500 + Math.random() * 1500;
    return 250 + Math.random() * 950;
  }

  getStaggerDelay(workerIndex: number): number {
    if (!this.adaptiveMode) return 0;
    return 200 + Math.random() * 400 + workerIndex * 100;
  }

  /* ------------------------------------------------------------------ */
  /*  Cooldown                                                           */
  /* ------------------------------------------------------------------ */

  isInCooldown(): boolean {
    return Date.now() < this.globalCooldownUntil;
  }

  getGlobalCooldownRemainingMs(): number {
    return Math.max(0, this.globalCooldownUntil - Date.now());
  }

  /* ------------------------------------------------------------------ */
  /*  Priority adjustment                                                */
  /* ------------------------------------------------------------------ */

  adjustPriority(basePriority: number, url: string, category: string): number {
    if (!this.adaptiveMode && this.consecutiveRateLimits === 0) return basePriority;
    const lowPriorityCategories = ['search', 'filter', 'tracking', 'functional'];
    if (lowPriorityCategories.some((c) => category.toLowerCase().includes(c))) {
      return Math.max(0, basePriority - 50);
    }
    return basePriority;
  }

  /* ------------------------------------------------------------------ */
  /*  Query methods                                                      */
  /* ------------------------------------------------------------------ */

  getConcurrency(): number {
    return this.currentConcurrencyVal;
  }

  getRetryDelayMs(retryAfterSec?: number): number {
    if (retryAfterSec !== undefined && retryAfterSec > 0) {
      console.log(`[AdaptiveCrawl] Retry-After respected: ${retryAfterSec}s`);
      return retryAfterSec * 1000;
    }
    if (this.currentBackoffStep < 0) return 1000;
    return this.backoffSteps[this.currentBackoffStep];
  }

  isThrottled(): boolean {
    return this.consecutiveRateLimits > 0;
  }

  hasPendingRetries(): boolean {
    return this.pendingRetries.length > 0;
  }

  getPendingRetryCount(): number {
    return this.pendingRetries.length;
  }

  getTotalRateLimits(): number {
    return this.totalRateLimits;
  }

  isShopify(): boolean {
    return this.detectedShopify;
  }

  getMetrics(): RateLimitMetrics {
    return {
      totalRateLimits: this.totalRateLimits,
      currentConcurrency: this.currentConcurrencyVal,
      baseConcurrency: this.baseConcurrency,
      isShopify: this.detectedShopify,
      adaptiveMode: this.adaptiveMode,
      globalCooldown: this.isInCooldown(),
      globalCooldownRemainingMs: this.getGlobalCooldownRemainingMs(),
      pendingRateLimited: this.getPendingRetryCount(),
    };
  }

  reset(): void {
    this.totalRateLimits = 0;
    this.consecutiveRateLimits = 0;
    this.currentBackoffStep = -1;
    this.currentConcurrencyVal = this.baseConcurrency;
    this.successesSinceRateLimit = 0;
    this.pendingRetries.length = 0;
    this.retryCountMap.clear();
    this.globalCooldownUntil = 0;
    this.detectedShopify = false;
    this.adaptiveMode = false;
  }
}
