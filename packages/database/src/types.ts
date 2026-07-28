export type CrawlJobStatus = 'pending' | 'running' | 'completed' | 'exporting' | 'building_wordpress' | 'starting_docker' | 'waiting_for_wordpress' | 'validating' | 'ready' | 'needs_review' | 'needs_reconstruction' | 'source_files_required' | 'partially_completed' | 'finished' | 'failed' | 'build_failed_recoverable' | 'cancelled';

export interface CrawlRecord {
  id: string;
  url: string;
  status: CrawlJobStatus;
  pagesVisited: number;
  pagesFailed: number;
  pagesDiscovered: number;
  maxPages: number;
  seoScore: number | null;
  seoReportJson: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
  exportStatusJson: string | null;
  builderStatus?: string | null;
  builderError?: string | null;
  siteUrl?: string | null;
  sitePort?: number | null;
  sitePath?: string | null;
  dockerStartedAt?: number | null;
  wordpressReadyAt?: number | null;
}
