import type { CrawlRecord, CrawlJobStatus } from './types.js';
import type { CrawlRepository } from './CrawlRepository.js';
import type { SqliteDatabase } from './Database.js';

type SqlValue = string | number | null;

type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value);
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function rowToRecord(row: Row): CrawlRecord {
  return {
    id: String(row.id),
    url: String(row.url),
    status: String(row.status) as CrawlJobStatus,
    pagesVisited: toNumber(row.pages_visited),
    pagesFailed: toNumber(row.pages_failed),
    pagesDiscovered: toNumber(row.pages_discovered),
    maxPages: toNumber(row.max_pages),
    seoScore: toNullableNumber(row.seo_score),
    seoReportJson: toNullableString(row.seo_report_json),
    startedAt: toNullableNumber(row.started_at),
    completedAt: toNullableNumber(row.completed_at),
    durationMs: toNullableNumber(row.duration_ms),
    error: toNullableString(row.error),
    createdAt: toNumber(row.created_at),
    exportStatusJson: toNullableString(row.export_status_json),
    builderStatus: toNullableString(row.builder_status), builderError: toNullableString(row.builder_error),
    siteUrl: toNullableString(row.site_url), sitePort: toNullableNumber(row.site_port),
    sitePath: toNullableString(row.site_path), dockerStartedAt: toNullableNumber(row.docker_started_at),
    wordpressReadyAt: toNullableNumber(row.wordpress_ready_at),
  };
}

export class SqliteCrawlRepository implements CrawlRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: CrawlRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO crawl_jobs
        (id, url, status, pages_visited, pages_failed, pages_discovered, max_pages,
         seo_score, seo_report_json, started_at, completed_at, duration_ms, error, created_at,
         export_status_json, builder_status, builder_error, site_url, site_port, site_path, docker_started_at, wordpress_ready_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.url, record.status,
      record.pagesVisited, record.pagesFailed, record.pagesDiscovered, record.maxPages,
      record.seoScore, record.seoReportJson,
      record.startedAt, record.completedAt, record.durationMs, record.error, record.createdAt,
      record.exportStatusJson ?? null,
      record.builderStatus ?? null, record.builderError ?? null, record.siteUrl ?? null, record.sitePort ?? null, record.sitePath ?? null,
      record.dockerStartedAt ?? null, record.wordpressReadyAt ?? null,
    );
  }

  async update(id: string, patch: Partial<Omit<CrawlRecord, 'id' | 'createdAt'>>): Promise<void> {
    const sets: string[] = [];
    const vals: SqlValue[] = [];

    if (patch.status !== undefined)         { sets.push('status = ?');          vals.push(patch.status); }
    if (patch.pagesVisited !== undefined)   { sets.push('pages_visited = ?');   vals.push(patch.pagesVisited); }
    if (patch.pagesFailed !== undefined)    { sets.push('pages_failed = ?');    vals.push(patch.pagesFailed); }
    if (patch.pagesDiscovered !== undefined){ sets.push('pages_discovered = ?');vals.push(patch.pagesDiscovered); }
    if (patch.maxPages !== undefined)       { sets.push('max_pages = ?');       vals.push(patch.maxPages); }
    if (patch.seoScore !== undefined)       { sets.push('seo_score = ?');       vals.push(patch.seoScore); }
    if (patch.seoReportJson !== undefined)  { sets.push('seo_report_json = ?'); vals.push(patch.seoReportJson); }
    if (patch.startedAt !== undefined)      { sets.push('started_at = ?');      vals.push(patch.startedAt); }
    if (patch.completedAt !== undefined)    { sets.push('completed_at = ?');    vals.push(patch.completedAt); }
    if (patch.durationMs !== undefined)     { sets.push('duration_ms = ?');     vals.push(patch.durationMs); }
    if (patch.error !== undefined)          { sets.push('error = ?');           vals.push(patch.error); }
    if (patch.url !== undefined)            { sets.push('url = ?');             vals.push(patch.url); }
    if (patch.exportStatusJson !== undefined) { sets.push('export_status_json = ?'); vals.push(patch.exportStatusJson); }
    if (patch.builderStatus !== undefined) { sets.push('builder_status = ?'); vals.push(patch.builderStatus); }
    if (patch.builderError !== undefined) { sets.push('builder_error = ?'); vals.push(patch.builderError); }
    if (patch.siteUrl !== undefined) { sets.push('site_url = ?'); vals.push(patch.siteUrl); }
    if (patch.sitePort !== undefined) { sets.push('site_port = ?'); vals.push(patch.sitePort); }
    if (patch.sitePath !== undefined) { sets.push('site_path = ?'); vals.push(patch.sitePath); }
    if (patch.dockerStartedAt !== undefined) { sets.push('docker_started_at = ?'); vals.push(patch.dockerStartedAt); }
    if (patch.wordpressReadyAt !== undefined) { sets.push('wordpress_ready_at = ?'); vals.push(patch.wordpressReadyAt); }

    if (sets.length === 0) return;
    vals.push(id);

    this.db.prepare(
      `UPDATE crawl_jobs SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...vals);
  }

  async findById(id: string): Promise<CrawlRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(id) as Row | undefined;
    return row !== undefined ? rowToRecord(row) : undefined;
  }

  async findSummaryById(id: string): Promise<CrawlRecord | undefined> {
    const row = this.db.prepare(`SELECT id, url, status, pages_visited, pages_failed, pages_discovered,
      max_pages, seo_score, NULL AS seo_report_json, started_at, completed_at, duration_ms, error,
      created_at, export_status_json, builder_status, builder_error, site_url, site_port, site_path,
      docker_started_at, wordpress_ready_at FROM crawl_jobs WHERE id = ?`).get(id) as Row | undefined;
    return row !== undefined ? rowToRecord(row) : undefined;
  }

  async findAll(): Promise<CrawlRecord[]> {
    const rows = this.db
      .prepare(`SELECT id, url, status, pages_visited, pages_failed, pages_discovered,
        max_pages, seo_score, NULL AS seo_report_json, started_at, completed_at, duration_ms, error,
        created_at, export_status_json, builder_status, builder_error, site_url, site_port, site_path,
        docker_started_at, wordpress_ready_at FROM crawl_jobs ORDER BY created_at DESC`)
      .all() as Row[];
    return rows.map(rowToRecord);
  }

  async findNonTerminal(): Promise<CrawlRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM crawl_jobs WHERE status NOT IN ('ready','needs_review','needs_reconstruction','partially_completed','finished','failed','cancelled') ORDER BY created_at ASC`).all() as Row[];
    return rows.map(rowToRecord);
  }
}
