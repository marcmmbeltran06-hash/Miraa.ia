import { WebCrawler } from '@autowp/crawler';
import { InMemoryEventBus } from '@autowp/event-bus';
import { BrowserPool } from '@autowp/browser';
import type { BrowserAdapter } from '@autowp/browser';
import type { CrawlRepository } from '@autowp/database';
import type { Logger } from '@autowp/logger';
import type { PageScreenshotData, SeoAnalyzer, SeoReport } from '@autowp/seo-analyzer';
import type { CrawlJobService, CrawlJobSummary, CrawlSubmitOptions, JobStatus, ReportArtifact } from './types.js';
import { buildExport, retryJsonExport, runAllExports } from './ExportService.js';
import type { CrawlDiagnostics, ExportStatusMap } from './ExportService.js';
import { WordPressSiteService } from './WordPressSiteService.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuilderProgressSummary } from './types.js';

/** Factory that creates a fresh BrowserPool per crawl job. */
export interface BrowserPoolFactory {
  create(): BrowserPool<unknown>;
}

/** Narrow contract used by the runner so WordPress startup can be tested without Docker. */
export interface WordPressSiteController {
  start(jobId: string): Promise<boolean>;
  pauseBuild(jobId: string): Promise<boolean>;
  cancelBuild(jobId: string): Promise<boolean>;
  restart(jobId: string): Promise<boolean>;
  rerunValidation(jobId: string): Promise<boolean>;
  stop(jobId: string): Promise<boolean>;
}

/** Creates a default factory from any BrowserAdapter. */
export function adapterFactory<S>(
  adapterCtor: () => BrowserAdapter<S>,
  maxSessions = 3,
): BrowserPoolFactory {
  return {
    create: () => new BrowserPool<S>({ adapter: adapterCtor(), maxSessions }),
  };
}

interface InternalJobState {
  jobId: string;
  url: string;
  status: JobStatus;
  pagesVisited: number;
  pagesPending: number;
  pagesDiscovered: number;
  maxPages: number;
  errors: string[];
  startedAt: Date | undefined;
  completedAt: Date | undefined;
  durationMs: number | undefined;
  seoScore: number | undefined;
  seoReport: SeoReport | undefined;
  crawler: WebCrawler | undefined;
  reportOnly: boolean;
}

function parseExportStatusJson(value: string | null | undefined): ExportStatusMap | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ExportStatusMap;
  } catch {
    return undefined;
  }
}

function stateToSummary(
  s: InternalJobState,
  exportStatus?: ExportStatusMap,
): CrawlJobSummary {
  const progress =
    s.pagesDiscovered > 0
      ? Math.min(100, Math.round((s.pagesVisited / s.pagesDiscovered) * 100))
      : s.status === 'finished' ? 100 : 0;

  return {
    jobId: s.jobId,
    url: s.url,
    status: s.status,
    pagesVisited: s.pagesVisited,
    pagesPending: s.pagesPending,
    errors: [...s.errors],
    progress,
    seoScore: s.seoScore,
    startedAt: s.startedAt?.toISOString(),
    completedAt: s.completedAt?.toISOString(),
    durationMs: s.durationMs,
    exports: exportStatus,
    reportOnly: s.reportOnly,
  };
}

export class CrawlJobRunner implements CrawlJobService {
  private readonly jobs = new Map<string, InternalJobState>();
  private readonly sites: WordPressSiteController;
  private readonly reportQueue: Array<{ jobId: string; url: string; state: InternalJobState }> = [];
  private activeReportJobs = 0;
  private readonly reportConcurrency: number;
  private readonly reportMaxPages: number;

  constructor(
    private readonly repository: CrawlRepository,
    private readonly poolFactory: BrowserPoolFactory,
    private readonly logger: Logger,
    private readonly seoAnalyzer: SeoAnalyzer,
    private readonly maxPages: number = 100,
    sites?: WordPressSiteController,
  ) {
    this.sites = sites ?? new WordPressSiteService(repository, logger);
    this.reportConcurrency = Math.max(1, Number(process.env.REPORT_CONCURRENCY ?? 32));
    this.reportMaxPages = Math.max(1, Number(process.env.REPORT_MAX_PAGES ?? 3));
  }

  async submit(url: string, options: CrawlSubmitOptions = {}): Promise<string> {
    const jobId = crypto.randomUUID();
    const now = Date.now();

    await this.repository.create({
      id: jobId,
      url,
      status: 'pending',
      pagesVisited: 0,
      pagesFailed: 0,
      pagesDiscovered: 0,
      maxPages: options.reportOnly === true && options.reportMode !== 'full' ? this.reportMaxPages : this.maxPages,
      seoScore: null,
      seoReportJson: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
      createdAt: now,
      exportStatusJson: null,
      builderStatus: null, builderError: null, siteUrl: null, sitePort: null, sitePath: null,
      dockerStartedAt: null, wordpressReadyAt: null,
    });

    const state: InternalJobState = {
      jobId,
      url,
      status: 'pending',
      pagesVisited: 0,
      pagesPending: 0,
      pagesDiscovered: 0,
      maxPages: options.reportOnly === true && options.reportMode !== 'full' ? this.reportMaxPages : this.maxPages,
      errors: [],
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
      seoScore: undefined,
      seoReport: undefined,
      crawler: undefined,
      reportOnly: options.reportOnly === true,
    };
    this.jobs.set(jobId, state);

    if (state.reportOnly) {
      this.reportQueue.push({ jobId, url, state });
      this.drainReportQueue();
    } else {
      this.startJob(jobId, url, state);
    }

    this.logger.info('Crawl job submitted', { jobId, url, reportOnly: state.reportOnly });
    return jobId;
  }

  private startJob(jobId: string, url: string, state: InternalJobState): void {
    this.runJob(jobId, url, state).catch((err: unknown) => {
      this.logger.error('Unexpected error in crawl job', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private drainReportQueue(): void {
    while (this.activeReportJobs < this.reportConcurrency && this.reportQueue.length > 0) {
      const next = this.reportQueue.shift();
      if (!next) return;
      if (next.state.status === 'cancelled') continue;
      this.activeReportJobs += 1;
      this.runJob(next.jobId, next.url, next.state)
        .catch((error: unknown) => {
          this.logger.error('Unexpected error in queued report job', {
            jobId: next.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.activeReportJobs = Math.max(0, this.activeReportJobs - 1);
          this.drainReportQueue();
        });
    }
  }

  async getStatus(jobId: string): Promise<CrawlJobSummary | undefined> {
    try {
      const state = this.jobs.get(jobId);
      if (state !== undefined) {
        return stateToSummary(state, undefined);
      }

      const record = this.repository.findSummaryById
        ? await this.repository.findSummaryById(jobId)
        : await this.repository.findById(jobId);
      if (record === undefined) return undefined;

      const progress =
        record.pagesDiscovered > 0
          ? Math.min(100, Math.round((record.pagesVisited / record.pagesDiscovered) * 100))
          : record.status === 'finished' ? 100 : 0;

      const exportStatus = parseExportStatusJson(record.exportStatusJson);
      const builderProgress = record.sitePath ? readBuilderProgress(record.sitePath) : undefined;

      return {
        jobId: record.id,
        url: record.url,
        status: record.status,
        pagesVisited: record.pagesVisited,
        pagesPending: 0,
        errors: record.error !== null ? [record.error] : [],
        progress,
        seoScore: record.seoScore ?? undefined,
        startedAt: record.startedAt !== null ? new Date(record.startedAt).toISOString() : undefined,
        completedAt:
          record.completedAt !== null ? new Date(record.completedAt).toISOString() : undefined,
        durationMs: record.durationMs ?? undefined,
        exports: exportStatus,
        builderStatus: record.builderStatus ?? undefined,
        builderProgress,
        builderError: record.builderError ?? undefined,
        siteUrl: record.siteUrl ?? undefined,
        sitePort: record.sitePort ?? undefined,
        sitePath: record.sitePath ?? undefined,
        dockerStartedAt: record.dockerStartedAt ? new Date(record.dockerStartedAt).toISOString() : undefined,
        wordpressReadyAt: record.wordpressReadyAt ? new Date(record.wordpressReadyAt).toISOString() : undefined,
      };
    } catch (err: unknown) {
      this.logger.error('Failed to load job status', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const state = this.jobs.get(jobId);
    if (state !== undefined) {
      if (state.status === 'completed' || state.status === 'exporting' || state.status === 'finished' || state.status === 'failed' || state.status === 'cancelled') {
        return false;
      }
      state.status = 'cancelled';
      state.crawler?.cancel();
      await this.repository.update(jobId, {
        status: 'cancelled',
        completedAt: Date.now(),
        error: 'Cancelled by user',
      });
      return true;
    }

    const record = await this.repository.findById(jobId);
    if (record && [
      'building_wordpress',
      'starting_docker',
      'waiting_for_wordpress',
      'validating',
      'build_failed_recoverable',
    ].includes(record.status)) {
      return this.sites.cancelBuild(jobId);
    }
    if (record === undefined || (record.status !== 'pending' && record.status !== 'running')) {
      return false;
    }

    await this.repository.update(jobId, {
      status: 'cancelled',
      completedAt: Date.now(),
      error: 'Cancelled by user',
    });
    return true;
  }

  async buildWordPress(jobId: string): Promise<boolean> { return this.sites.start(jobId); }
  async pauseWordPressBuild(jobId: string): Promise<boolean> { return this.sites.pauseBuild(jobId); }
  async resumeWordPressBuild(jobId: string): Promise<boolean> { return this.sites.start(jobId); }
  async retryFailedExports(jobId: string): Promise<boolean> {
    const record = await this.repository.findById(jobId);
    if (!record?.seoReportJson) return false;
    const status = parseExportStatusJson(record.exportStatusJson) ?? {};
    const jobDir = path.join('auditoria', jobId);
    const errorsPath = path.join(jobDir, 'export-errors.json');
    const jsonFailed = status.json === 'failed'
      || !fs.existsSync(path.join(jobDir, 'seo-report.json'))
      || fs.existsSync(errorsPath);
    if (!jsonFailed) return true;
    try {
      const report = JSON.parse(record.seoReportJson) as SeoReport;
      retryJsonExport(jobId, report);
      status.json = 'ok';
      const remainingErrors = fs.existsSync(errorsPath)
        ? JSON.parse(fs.readFileSync(errorsPath, 'utf8')) as { errors?: unknown[] }
        : { errors: [] };
      await this.repository.update(jobId, {
        exportStatusJson: JSON.stringify(status),
        error: (remainingErrors.errors?.length ?? 0) > 0
          ? `${remainingErrors.errors?.length ?? 0} export(s) failed`
          : null,
      });
      return true;
    } catch (error) {
      this.logger.error('Failed to retry JSON export', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  async cancelWordPressBuild(jobId: string): Promise<boolean> { return this.sites.cancelBuild(jobId); }
  async restartSite(jobId: string): Promise<boolean> { return this.sites.restart(jobId); }
  async rerunValidation(jobId: string): Promise<boolean> { return this.sites.rerunValidation(jobId); }
  async stopSite(jobId: string): Promise<boolean> { return this.sites.stop(jobId); }

  async getReportArtifact(jobId: string, format: 'html' | 'pdf' | 'json' | 'csv' | 'zip' | 'mira'): Promise<ReportArtifact | undefined> {
    const record = await this.repository.findById(jobId);
    if (!record?.seoReportJson || !['completed', 'finished', 'ready', 'needs_review', 'needs_reconstruction', 'cancelled'].includes(record.status)) {
      return undefined;
    }
    try {
      return buildExport(JSON.parse(record.seoReportJson) as SeoReport, format, jobId);
    } catch (error) {
      this.logger.warn('Report artifact is unavailable', {
        jobId,
        format,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async runJob(jobId: string, url: string, state: InternalJobState): Promise<void> {
    const startedAt = Date.now();
    state.status = 'running';
    state.startedAt = new Date(startedAt);

    await this.repository.update(jobId, { status: 'running', startedAt });

    const eventBus = new InMemoryEventBus();

    interface VisitedPageData {
      statusCode: number;
      durationMs: number;
    }
    interface ParsedPageData {
      html: string;
      depth: number;
      pageContent?: string;
      computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
      screenshot?: PageScreenshotData;
    }
    const visitedData = new Map<string, VisitedPageData>();
    const parsedData = new Map<string, ParsedPageData>();
    const logMemory = (stage: string): void => {
      const m = process.memoryUsage();
      this.logger.info(`[Memory] ${stage}`, { jobId, heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external });
    };

    const stateSubscription = eventBus.subscribeAll((event) => {
      switch (event.type) {
        case 'PageDiscovered':
          state.pagesDiscovered += 1;
          state.pagesPending += 1;
          break;
        case 'PageVisited': {
          state.pagesVisited += 1;
          state.pagesPending = Math.max(0, state.pagesPending - 1);
          const vp = event.payload as { url: string; status: number; durationMs: number };
          visitedData.set(vp.url, { statusCode: vp.status, durationMs: vp.durationMs });
          break;
        }
        case 'PageParsed': {
          const pp = event.payload as {
            url: string;
            depth: number;
            parse: { html: string };
            pageContent?: string;
            computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
            screenshot?: PageScreenshotData;
          };
          parsedData.set(pp.url, {
            html: pp.parse.html,
            depth: pp.depth,
            pageContent: pp.pageContent,
            computedStyles: pp.computedStyles,
            screenshot: pp.screenshot,
          });
          break;
        }
        case 'PageFailed': {
          state.pagesPending = Math.max(0, state.pagesPending - 1);
          const payload = event.payload as { error?: string };
          state.errors.push(payload.error ?? 'Unknown error');
          break;
        }
        default:
          break;
      }
    });

    const pool = this.poolFactory.create();

    try {
      const crawler = new WebCrawler({
        startUrls: [url],
        browserPool: pool,
        eventBus,
        maxPages: state.maxPages,
        timeoutMs: state.reportOnly ? 120_000 : 7_200_000,
        patternExplosionLimit: 200,
      });
      state.crawler = crawler;

      const result = await crawler.crawl();
      logMemory('after crawl');
      const completedAt = Date.now();

      // Phase 1: Determine crawl outcome
      state.status = result.cancelled ? 'cancelled' : 'completed';
      if (!result.cancelled && result.terminationReason) {
        this.logger.info('Crawl finished', {
          jobId,
          terminationReason: result.terminationReason,
          pendingDiscarded: result.pendingDiscarded ?? 0,
          discoveryPaused: result.terminationDiagnostics?.metricsAtDecision.discoveryPaused,
        });
      }
      state.completedAt = new Date(completedAt);
      state.durationMs = result.durationMs;

      // Run SEO analysis from collected page data
      try {
        const pages = [...parsedData.entries()].map(([pageUrl, pd]) => {
          const vd = visitedData.get(pageUrl);
          const htmlBytes = new TextEncoder().encode(pd.html).length;
          return {
            url: pageUrl,
            finalUrl: pageUrl,
            statusCode: vd?.statusCode ?? 200,
            html: pd.html,
            depth: pd.depth,
            responseTimeMs: vd?.durationMs,
            htmlSizeBytes: htmlBytes,
            pageContent: pd.pageContent,
            computedStyles: pd.computedStyles,
            screenshot: pd.screenshot,
          };
        });

        const seoReport = this.seoAnalyzer.analyze({ entryUrl: url, pages });
        state.seoScore = seoReport.score;
        state.seoReport = seoReport;
        logMemory('after SEO');
      } catch (seoErr: unknown) {
        this.logger.warn('SEO analysis failed', {
          jobId,
          error: seoErr instanceof Error ? seoErr.message : String(seoErr),
        });
      }

      // Phase 2: Persist job IMMEDIATELY after crawl (before any export)
      this.logger.info('Persisting job', { jobId, status: 'completed' });

      // Build diagnostics payload
      const crawlDiag = result.diagnostics;
      const diagnostics: CrawlDiagnostics | undefined = crawlDiag && state.seoReport
        ? {
            crawlDiagnostics: crawlDiag as unknown as Record<string, unknown>,
            knowledgeDiagnostics: {
              totalPages: result.pagesVisited,
              totalProducts: state.seoReport.summary.totalProducts,
              urlCategories: crawlDiag.urlCategories,
              pageDuplicateCounts: crawlDiag.pageDuplicateCounts,
              pageVisitedDuplicateCounts: crawlDiag.pageVisitedDuplicateCounts,
              patternCounts: crawlDiag.patternCounts,
              terminationReason: result.terminationReason,
              pendingUrlsAtEnd: crawlDiag.pendingUrls,
            },
            schedulerDiagnostics: {
              evolution: crawlDiag.evolution,
              stabilityHistory: crawlDiag.stabilityHistory,
              maxMemory: crawlDiag.maxMemory,
              terminationReason: result.terminationReason,
              discoveryPaused: crawlDiag.discoveryPaused,
              cancelSource: crawlDiag.cancelSource,
            },
          }
        : undefined;

      // If crawl was cancelled or produced no knowledge, persist and stop
      if (result.cancelled) {
        this.logger.info('Crawl job cancelled', { jobId, terminationReason: result.terminationReason ?? 'unknown' });
        await this.repository.update(jobId, {
          status: 'cancelled',
          pagesVisited: result.pagesVisited,
          pagesFailed: result.pagesFailed,
          pagesDiscovered: result.pagesDiscovered,
          completedAt,
          durationMs: result.durationMs,
          error: 'Cancelled',
        });
        return;
      }

      if (state.seoReport === undefined) {
        state.status = 'failed';
        state.errors.push('No knowledge captured');
        await this.repository.update(jobId, {
          status: 'failed',
          pagesVisited: result.pagesVisited,
          pagesFailed: result.pagesFailed,
          pagesDiscovered: result.pagesDiscovered,
          completedAt,
          durationMs: result.durationMs,
          error: 'No knowledge captured',
        });
        return;
      }

      // Persist as completed (with SEO report, without export status yet)
      await this.repository.update(jobId, {
        status: 'completed',
        pagesVisited: result.pagesVisited,
        pagesFailed: result.pagesFailed,
        pagesDiscovered: result.pagesDiscovered,
        seoScore: state.seoReport.score,
        seoReportJson: JSON.stringify({
          score: state.seoReport.score,
          summary: state.seoReport.summary,
          criticalErrors: state.seoReport.criticalErrors,
          warnings: state.seoReport.warnings,
          info: state.seoReport.info,
          pages: state.seoReport.pages.map((p) => ({
            url: p.url, finalUrl: p.finalUrl, statusCode: p.statusCode, depth: p.depth,
            responseTimeMs: p.responseTimeMs, htmlSizeBytes: p.htmlSizeBytes, title: p.title,
            metaDescription: p.metaDescription, canonical: p.canonical, robots: p.robots,
            headings: p.headings, indexability: p.indexability, issues: p.issues,
            products: [], images: [], internalLinks: [], externalLinks: [], brokenLinks: [],
            anchorTexts: [], imagesWithoutAlt: [], heavyImages: [], wordCount: p.wordCount,
            thinContent: p.thinContent, noindex: p.noindex, nofollow: p.nofollow,
            securityHeaders: {}, openGraph: {}, twitter: {}, jsonLd: [], structuredDataTypes: [],
          })),
        }),
        error: null,
        completedAt,
        durationMs: result.durationMs,
      });
      this.logger.info('Job persisted', { jobId });
      state.status = 'completed';

      // Phase 3: Run exports independently (job is already safe in DB)
      this.logger.info('Starting exports', { jobId });
      state.status = 'exporting';
      await this.repository.update(jobId, { status: 'exporting' });

      // Run all exports — each is independent, failures are collected
      // WordPress is now the only product flow, so generate every artifact the
      // builder validates before it is started (including products and WooCommerce).
      const exportResult = await runAllExports(state.seoReport, jobId, diagnostics, [], false);
      logMemory('after export');

      const hasExportErrors = exportResult.errors.length > 0;
      await this.repository.update(jobId, {
        status: 'completed',
        exportStatusJson: JSON.stringify(exportResult.status),
        error: hasExportErrors
          ? `${exportResult.errors.length} export(s) failed`
          : null,
      });

      if (state.reportOnly) {
        state.status = 'finished';
        await this.repository.update(jobId, {
          status: 'finished',
          error: hasExportErrors ? `${exportResult.errors.length} export(s) failed` : null,
        });
        state.seoReport = undefined;
        parsedData.clear();
        visitedData.clear();
        this.logger.info('Standalone report job finished', { jobId, url });
        return;
      }

      const buildStarted = await this.sites.start(jobId);
      if (!buildStarted) throw new Error('WordPress builder could not start from the generated export.');
      state.status = 'building_wordpress';
      state.seoReport = undefined;
      parsedData.clear();
      visitedData.clear();
      logMemory('before WordPress builder');

      if (hasExportErrors) {
        this.logger.warn('Export finished with errors', {
          jobId,
          failed: exportResult.errors.map((e) => e.exportName).join(', '),
        });
      } else {
        this.logger.info('Export finished', { jobId });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      state.status = 'failed';
      state.completedAt = new Date();
      state.errors.push(message);

      await this.repository.update(jobId, {
        status: 'failed',
        error: message,
        completedAt: Date.now(),
      });

      this.logger.error('Crawl job failed', { jobId, error: message });
    } finally {
      state.seoReport = undefined;
      parsedData.clear();
      visitedData.clear();
      state.crawler = undefined;
      stateSubscription.unsubscribe();
      if (state.status === 'building_wordpress' || state.status === 'finished' || state.status === 'cancelled' || state.status === 'failed') {
        this.jobs.delete(jobId);
      }
    }
  }
}

function readBuilderProgress(sitePath: string): BuilderProgressSummary | undefined {
  try {
    const progressPath = path.join(sitePath, 'validation', 'builder-progress.json');
    const parsed = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as BuilderProgressSummary;
    if (
      typeof parsed.phase !== 'string'
      || typeof parsed.label !== 'string'
      || typeof parsed.percent !== 'number'
      || !Array.isArray(parsed.stages)
    ) return undefined;
    const checkpointPath = path.join(sitePath, '.autowp-build', 'checkpoint.json');
    if (fs.existsSync(checkpointPath)) {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {
        startedAt?: string;
        heartbeatAt?: string;
        control?: string;
        phases?: Record<string, {
          status?: string;
          updatedAt?: string;
          batches?: Record<string, { completed: number; total: number; lastItem?: string }>;
        }>;
      };
      const phases = Object.entries(checkpoint.phases ?? {});
      const active = phases.find(([, phase]) => ['running', 'failed', 'paused'].includes(phase.status ?? ''))
        ?? phases.find(([, phase]) => phase.status !== 'completed');
      if (active) {
        const [phaseId, phase] = active;
        const batches = Object.values(phase.batches ?? {});
        const processedItems = batches.reduce((sum, batch) => sum + batch.completed, 0);
        const totalItems = batches.reduce((sum, batch) => sum + batch.total, 0);
        const elapsedMs = checkpoint.startedAt ? Math.max(0, Date.now() - Date.parse(checkpoint.startedAt)) : parsed.elapsedMs;
        const itemsPerSecond = processedItems > 0 && elapsedMs ? processedItems / (elapsedMs / 1_000) : undefined;
        Object.assign(parsed, {
          phase: phaseId,
          label: checkpoint.control === 'paused' ? 'Construcción pausada' : phaseId.replaceAll('_', ' '),
          status: phase.status === 'failed' ? 'failed' : 'running',
          lastItem: batches.at(-1)?.lastItem,
          processedItems,
          totalItems,
          itemsPerSecond,
          elapsedMs,
          estimatedRemainingMs: itemsPerSecond && totalItems > processedItems
            ? Math.round(((totalItems - processedItems) / itemsPerSecond) * 1_000)
            : undefined,
          heartbeatAt: checkpoint.heartbeatAt,
          updatedAt: phase.updatedAt ?? parsed.updatedAt,
        });
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}
