// -----------------------------------------------------------------------
// Types that mirror the backend wire-format.
// The frontend communicates only via HTTP — no imports from backend packages.
// -----------------------------------------------------------------------

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
  seoScore?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  builderStatus?: string;
  builderProgress?: BuilderProgressSummary;
  builderError?: string;
  siteUrl?: string;
  sitePort?: number;
  sitePath?: string;
  dockerStartedAt?: string;
  wordpressReadyAt?: string;
  reportOnly?: boolean;
}

// ── SEO types ────────────────────────────────────────────────────────────

export type SeoIssueSeverity = 'critical' | 'warning' | 'info';

export interface SeoIssue {
  code: string;
  severity: SeoIssueSeverity;
  message: string;
  pageUrl?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface PageHeadingData {
  h1: string[];
  h2: string[];
  h3: string[];
}

export interface OpenGraphData {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
}

export interface TwitterCardData {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
}

export interface AnchorTextData {
  href: string;
  text: string;
  external: boolean;
}

export interface ImageData {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface ProductData {
  name?: string;
  price?: string;
  description?: string;
  images: string[];
  sku?: string;
  categories: string[];
  attributes: Record<string, string>;
  variants: Array<Record<string, string>>;
  sourceUrl: string;
}

export interface SeoPageReport {
  url: string;
  finalUrl: string;
  statusCode: number;
  depth: number;
  responseTimeMs?: number;
  htmlSizeBytes: number;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robots?: string;
  headings: PageHeadingData;
  openGraph: OpenGraphData;
  twitter: TwitterCardData;
  jsonLd: unknown[];
  structuredDataTypes: string[];
  internalLinks: string[];
  externalLinks: string[];
  brokenLinks: string[];
  anchorTexts: AnchorTextData[];
  images: ImageData[];
  redirectsTo?: string;
  imagesWithoutAlt: string[];
  heavyImages: string[];
  wordCount: number;
  thinContent: boolean;
  indexability: 'indexable' | 'noindex' | 'blocked' | 'error';
  noindex: boolean;
  nofollow: boolean;
  securityHeaders: Record<string, string>;
  products: ProductData[];
  issues: SeoIssue[];
  /** Full visible body text content (for WordPress post content reconstruction) */
  pageContent?: string;
  /** Full raw HTML of the page (for components that cannot be modeled) */
  pageHtml?: string;
  /** Computed CSS styles for layout sections (extracted at crawl time via getComputedStyle) */
  computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
}

export interface DuplicateValueGroup {
  value: string;
  urls: string[];
}

export interface SeoSummary {
  totalPages: number;
  redirects: number;
  brokenLinks: number;
  pagesWithoutTitle: number;
  pagesWithoutDescription: number;
  duplicateTitles: DuplicateValueGroup[];
  duplicateDescriptions: DuplicateValueGroup[];
  noindexPages: number;
  thinContentPages: number;
  totalProducts: number;
}

export interface SeoReport {
  score: number;
  criticalErrors: SeoIssue[];
  warnings: SeoIssue[];
  info: SeoIssue[];
  summary: SeoSummary;
  pages: SeoPageReport[];
}
