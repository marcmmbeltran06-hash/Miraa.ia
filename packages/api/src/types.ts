import type { ExportStatusMap } from './ExportService.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'exporting' | 'building_wordpress' | 'starting_docker' | 'waiting_for_wordpress' | 'validating' | 'ready' | 'needs_review' | 'needs_reconstruction' | 'source_files_required' | 'partially_completed' | 'finished' | 'failed' | 'build_failed_recoverable' | 'cancelled';

export interface BuilderProgressSummary {
  phase: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  completed: number;
  total: number;
  percent: number;
  currentItem?: string;
  lastItem?: string;
  processedItems?: number;
  totalItems?: number;
  itemsPerSecond?: number;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
  heartbeatAt?: string;
  updatedAt: string;
  stages: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'; percent: number }>;
}

export interface CrawlJobSummary {
  jobId: string;
  url: string;
  status: JobStatus;
  pagesVisited: number;
  pagesPending: number;
  errors: string[];
  /** 0–100 */
  progress: number;
  /** SEO score 0–100, available once job is completed */
  seoScore?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Per-format export status (json, csv, html, pdf, zip, woocommerce, wordpress) */
  exports?: ExportStatusMap;
  builderStatus?: string;
  builderProgress?: BuilderProgressSummary;
  builderError?: string;
  siteUrl?: string;
  sitePort?: number;
  sitePath?: string;
  dockerStartedAt?: string;
  wordpressReadyAt?: string;
  /** True when the job only produces reports and never starts WordPress. */
  reportOnly?: boolean;
}

export interface CrawlSubmitOptions {
  reportOnly?: boolean;
  /** Full explores the complete discoverable site; quick is intended for very large batches. */
  reportMode?: 'full' | 'quick';
}

export interface ReportArtifact {
  filename: string;
  contentType: string;
  body?: string | Buffer;
  filePath?: string;
}

/**
 * Domain-agnostic service interface consumed by the HTTP layer.
 * The API knows ONLY this contract — not the crawler implementation.
 */
export interface CrawlJobService {
  submit(url: string, options?: CrawlSubmitOptions): Promise<string>;
  getStatus(jobId: string): Promise<CrawlJobSummary | undefined>;
  cancel(jobId: string): Promise<boolean>;
  buildWordPress(jobId: string): Promise<boolean>;
  pauseWordPressBuild(jobId: string): Promise<boolean>;
  resumeWordPressBuild(jobId: string): Promise<boolean>;
  cancelWordPressBuild(jobId: string): Promise<boolean>;
  retryFailedExports(jobId: string): Promise<boolean>;
  restartSite(jobId: string): Promise<boolean>;
  rerunValidation(jobId: string): Promise<boolean>;
  stopSite(jobId: string): Promise<boolean>;
  getReportArtifact?(jobId: string, format: 'html' | 'pdf' | 'json' | 'csv' | 'zip' | 'mira'): Promise<ReportArtifact | undefined>;
}
