import type { Identifier, Logger } from '@autowp/shared';
import type { EventBus } from '@autowp/event-bus';
import type { SeoAnalyzer, SeoReport } from '@autowp/seo-analyzer';

export interface CrawlSnapshot {
  url: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  links: string[];
  depth: number;
  responseTimeMs?: number;
  htmlSizeBytes?: number;
  discoveredAt: Date;
}

export interface Crawler {
  crawl(entryUrl: string, maxPages?: number): Promise<CrawlSnapshot[]>;
}

export interface PipelineOptions {
  entryUrl: string;
  maxPages?: number;
}

export interface PipelineResult {
  websiteId: string;
  entryUrl: string;
  visitedPages: number;
  completedAt: Date;
  snapshots: CrawlSnapshot[];
  seoReport: SeoReport;
}

export interface PipelineDependencies {
  crawler: Crawler;
  seoAnalyzer: SeoAnalyzer;
  eventBus: EventBus;
  idGenerator: { generate(): Identifier };
  logger: Logger;
}
