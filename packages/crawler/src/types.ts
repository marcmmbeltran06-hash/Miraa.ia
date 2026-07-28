import type { BrowserPool } from '@autowp/browser';
import type { EventBus } from '@autowp/event-bus';
import type { Queue } from '@autowp/queue';
import type { HtmlParseResult } from '@autowp/html-parser';

export type CrawlStrategy = 'bfs' | 'dfs';
export type LinkType = 'internal' | 'external';

export interface CrawlerOptions {
  startUrls: string[];
  browserPool: BrowserPool<unknown>;
  eventBus: EventBus;
  concurrency?: number;
  strategy?: CrawlStrategy;
  maxDepth?: number;
  maxPages?: number;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  rateLimitMs?: number;
  excludeExternalDomains?: boolean;
  allowedDomains?: string[];
  queue?: Queue<void>;
  userAgent?: string;
  stagnationLimit?: number;
  stabilityWindowMs?: number;
  rateDelayMs?: number;
  robotsTxtEnabled?: boolean;
  /** Maximum number of URLs per URL pattern before explosion limit kicks in. Increase for large catalogs (Shopify, Magento). */
  patternExplosionLimit?: number;
}

export interface CrawlTask {
  url: string;
  depth: number;
  sourceUrl?: string;
  priority?: number;
}

import type { TerminationDiagnostics, CancelSource } from './TerminationDiagnostics.js';

export interface CrawlResult {
  pagesVisited: number;
  pagesFailed: number;
  pagesDiscovered: number;
  durationMs: number;
  cancelled: boolean;
  duplicates?: number;
  discarded?: number;
  pendingDiscarded?: number;
  terminationReason?: string;
  terminationDiagnostics?: TerminationDiagnostics;
  cancelSource?: CancelSource;
  memoryUsage?: NodeJS.MemoryUsage;
  /** Serialisable crawl diagnostics for inclusion in export ZIP. */
  diagnostics?: {
    urlCategories: Record<string, string>;
    evolution: { timestamp: number; frontier: number; queue: number }[];
    termination: TerminationDiagnostics | undefined;
    stabilityHistory: import('./StabilityMonitor.js').StabilityEvaluation[];
    pendingUrls: string[];
    discoveryPaused: boolean;
    cancelSource: CancelSource | undefined;
    pageDuplicateCounts: Record<string, number>;
    pageVisitedDuplicateCounts: Record<string, number>;
    patternCounts: Record<string, number>;
    maxMemory: { heapUsed: number; heapTotal: number; rss: number; external: number };
  };
}

export interface ParsedPageResult {
  url: string;
  depth: number;
  html: string;
  parse: HtmlParseResult;
}

export interface CrawlPageSummary {
  url: string;
  depth: number;
  status: number;
  durationMs: number;
}
