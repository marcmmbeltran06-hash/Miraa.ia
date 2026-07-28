import type { StabilityEvaluation, StabilitySnapshot } from './StabilityMonitor.js';

export type CancelSource = 'user' | 'timeout' | 'stability_monitor' | 'unknown';

export interface PendingUrlSample {
  url: string;
  depth: number;
  priority?: number;
  sourceUrl?: string;
  classification: 'frontier' | 'queued';
}

export interface TerminationDiagnostics {
  timestamp: number;
  reason: string;
  invokedBy: string;
  cancelSource?: CancelSource;
  cancelStack?: string;
  pendingAtDecision: {
    frontier: number;
    queue: number;
    total: number;
  };
  pendingDiscarded: number;
  discardJustification?: string;
  stabilityEvaluation?: StabilityEvaluation;
  metricsAtDecision: StabilitySnapshot & {
    pagesVisited: number;
    duplicates: number;
    discarded: number;
    activeWorkers: number;
    discoveryPaused: boolean;
  };
  pendingUrlSamples: PendingUrlSample[];
  stabilityHistory: StabilityEvaluation[];
}

export function captureStack(skipFrames = 2): string {
  const stack = new Error().stack ?? '';
  return stack
    .split('\n')
    .slice(skipFrames)
    .join('\n')
    .trim();
}
