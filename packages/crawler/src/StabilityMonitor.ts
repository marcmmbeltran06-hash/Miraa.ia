export type StabilityVerdict = 'continue' | 'pause_discovery' | 'complete' | 'exhausted';

export type TerminationReason =
  | 'all_criteria_stable'
  | 'knowledge_stagnation'
  | 'queue_drained'
  | 'exhausted';

export interface StabilitySnapshot {
  queueSize: number;
  knowledgeSize: number;
  discovered: number;
  processed: number;
  memoryRss: number;
  activeWorkers: number;
  /** URLs in the queue that represent genuinely new knowledge (not duplicates/assets) */
  pendingKnowledge: number;
  /** Ratio of new vs total discoveries in the last window */
  discoveryNovelty: number;
}

export interface StabilityEvaluation {
  verdict: StabilityVerdict;
  reason?: TerminationReason;
  stableWindows: number;
  criteria: {
    queueStable: boolean;
    knowledgeStable: boolean;
    discoveryStable: boolean;
    processedStable: boolean;
    workersHealthy: boolean;
    memoryStable: boolean;
  };
  metrics: {
    previous: StabilitySnapshot | null;
    current: StabilitySnapshot;
    deltas: {
      queueSize: number;
      knowledgeSize: number;
      discovered: number;
      processed: number;
      memoryRss: number;
    };
  };
  justification: string;
}

/**
 * Tracks crawl stability across consecutive observation windows.
 *
 * Never recommends clearing the queue. When knowledge stagnates while workers
 * are still active, recommends pausing discovery only. Completion happens
 * only when the queue is naturally drained.
 */
export class StabilityMonitor {
  private previous: StabilitySnapshot | null = null;
  private consecutiveAllStable = 0;
  private consecutiveKnowledgeStagnant = 0;
  /** Counts consecutive stagnant windows AFTER pause_discovery was already recommended */
  private consecutivePostPauseStagnant = 0;
  private pausedRecommended = false;
  readonly history: StabilityEvaluation[] = [];

  constructor(
    private readonly requiredStableWindows: number,
    private readonly memoryToleranceRatio = 0.05,
    /** After pause is recommended, how many extra stagnant windows before exhaustion? */
    private readonly exhaustionWindowMultiplier = 3,
  ) {}

  evaluate(current: StabilitySnapshot): StabilityEvaluation {
    if (!this.previous) {
      this.previous = current;
      const evaluation = this.buildEvaluation('continue', {
        queueStable: false,
        knowledgeStable: false,
        discoveryStable: false,
        processedStable: false,
        workersHealthy: true,
        memoryStable: true,
      }, current, 'Initial observation window – collecting baseline metrics.');
      this.history.push(evaluation);
      return evaluation;
    }

    const queueStable = current.queueSize === this.previous.queueSize;
    const knowledgeStable = current.knowledgeSize === this.previous.knowledgeSize;
    const discoveryStable = current.discovered === this.previous.discovered;
    const processedStable = current.processed === this.previous.processed;

    const workersBlocked =
      current.queueSize > 0 &&
      processedStable &&
      current.activeWorkers === 0;
    const workersHealthy = !workersBlocked;

    const memoryDelta = Math.abs(current.memoryRss - this.previous.memoryRss);
    const memoryStable =
      this.previous.memoryRss === 0 ||
      memoryDelta <= this.previous.memoryRss * this.memoryToleranceRatio;

    const criteria = {
      queueStable,
      knowledgeStable,
      discoveryStable,
      processedStable,
      workersHealthy,
      memoryStable,
    };

    const allStable =
      queueStable &&
      knowledgeStable &&
      discoveryStable &&
      processedStable &&
      workersHealthy &&
      memoryStable;

    if (allStable) {
      this.consecutiveAllStable += 1;
    } else {
      this.consecutiveAllStable = 0;
    }

    // Knowledge stagnation only counts when workers also stopped making progress.
    if (knowledgeStable && discoveryStable && processedStable && current.queueSize > 0) {
      this.consecutiveKnowledgeStagnant += 1;
    } else {
      this.consecutiveKnowledgeStagnant = 0;
    }

    const previous = this.previous;
    this.previous = current;

    if (current.queueSize === 0 && current.activeWorkers === 0) {
      if (this.pausedRecommended) this.pausedRecommended = false;
      const evaluation = this.buildEvaluation(
        'complete',
        criteria,
        current,
        `Queue drained naturally: processed=${current.processed}, discovered=${current.discovered}, knowledge=${current.knowledgeSize}.`,
        'queue_drained',
      );
      this.history.push(evaluation);
      return evaluation;
    }

    const isStagnant = this.consecutiveKnowledgeStagnant >= this.requiredStableWindows;
    const isAllStable = this.consecutiveAllStable >= this.requiredStableWindows;

    if (isStagnant) {
      if (!this.pausedRecommended) {
        this.pausedRecommended = true;
        this.consecutivePostPauseStagnant = 0;
        const evaluation = this.buildEvaluation(
          'pause_discovery',
          criteria,
          current,
          `Knowledge stagnant for ${this.consecutiveKnowledgeStagnant} windows ` +
            `(queue=${current.queueSize}, processed=${current.processed}, ` +
            `discovered=${current.discovered}, knowledge=${current.knowledgeSize}). ` +
            `Pausing new URL discovery; existing queue will drain without discarding pending URLs.`,
          'knowledge_stagnation',
        );
        this.history.push(evaluation);
        return evaluation;
      }

      // Post-pause: count how many stagnant windows have passed since pause was recommended
      this.consecutivePostPauseStagnant++;
      const exhaustionThreshold = this.requiredStableWindows * this.exhaustionWindowMultiplier;

      if (this.consecutivePostPauseStagnant >= exhaustionThreshold) {
        // Exhaustion: discovery is paused, queue hasn't drained, no new knowledge appearing
        const evaluation = this.buildEvaluation(
          'exhausted',
          criteria,
          current,
          `Post-pause exhaustion after ${this.consecutivePostPauseStagnant} stagnant windows ` +
            `(queue=${current.queueSize}, processed=${current.processed}, ` +
            `discovered=${current.discovered}, knowledge=${current.knowledgeSize}). ` +
            `Remaining items appear to be non-productive. Declaring crawl complete.`,
          'exhausted',
        );
        this.history.push(evaluation);
        return evaluation;
      }

      // Still in post-pause draining phase
      const evaluation = this.buildEvaluation(
        'pause_discovery',
        criteria,
        current,
        `Post-pause drain in progress: ${this.consecutivePostPauseStagnant}/${exhaustionThreshold} windows ` +
          `(queue=${current.queueSize}, processed=${current.processed}, ` +
          `discovered=${current.discovered}). Queue continuing to drain.`,
        'knowledge_stagnation',
      );
      this.history.push(evaluation);
      return evaluation;
    }

    if (isAllStable && current.queueSize > 0) {
      if (!this.pausedRecommended) {
        this.pausedRecommended = true;
        this.consecutivePostPauseStagnant = 0;
      }
      const evaluation = this.buildEvaluation(
        'pause_discovery',
        criteria,
        current,
        `All five stability criteria met for ${this.consecutiveAllStable} consecutive windows ` +
          `with ${current.queueSize} URLs still pending. Pausing discovery; queue continues draining.`,
        'all_criteria_stable',
      );
      this.history.push(evaluation);
      return evaluation;
    }

    // Not stagnant and not all stable — reset pause tracking
    if (this.pausedRecommended && !isStagnant) {
      this.pausedRecommended = false;
      this.consecutivePostPauseStagnant = 0;
    }

    const evaluation = this.buildEvaluation(
      'continue',
      criteria,
      current,
      `Crawl active: queue=${current.queueSize}, processed=${current.processed} (+${current.processed - previous.processed}), ` +
        `discovered=${current.discovered} (+${current.discovered - previous.discovered}), ` +
        `workers=${current.activeWorkers}.`,
    );
    this.history.push(evaluation);
    return evaluation;
  }

  /**
   * Force an evaluation that skips the first-window baseline and inflates
   * stagnation counters to trigger exhaustion. Used by the timeout safety net
   * to unblock a crawl that has exceeded its expected runtime.
   */
  forceEvaluation(current: StabilitySnapshot): StabilityEvaluation {
    if (!this.previous) {
      this.previous = current;
    }
    // Inflate stagnation counters to trigger pause → exhaustion chain quickly
    this.consecutiveKnowledgeStagnant = Math.max(
      this.consecutiveKnowledgeStagnant,
      this.requiredStableWindows,
    );
    // If pause was already recommended, push toward exhaustion
    if (this.pausedRecommended) {
      this.consecutivePostPauseStagnant += this.requiredStableWindows;
    }
    return this.evaluate(current);
  }

  private buildEvaluation(
    verdict: StabilityVerdict,
    criteria: StabilityEvaluation['criteria'],
    current: StabilitySnapshot,
    justification: string,
    reason?: TerminationReason,
  ): StabilityEvaluation {
    const previous = this.previous;
    return {
      verdict,
      reason,
      stableWindows: Math.max(this.consecutiveAllStable, this.consecutiveKnowledgeStagnant),
      criteria,
      metrics: {
        previous,
        current,
        deltas: {
          queueSize: previous ? current.queueSize - previous.queueSize : 0,
          knowledgeSize: previous ? current.knowledgeSize - previous.knowledgeSize : 0,
          discovered: previous ? current.discovered - previous.discovered : 0,
          processed: previous ? current.processed - previous.processed : 0,
          memoryRss: previous ? current.memoryRss - previous.memoryRss : 0,
        },
      },
      justification,
    };
  }
}
