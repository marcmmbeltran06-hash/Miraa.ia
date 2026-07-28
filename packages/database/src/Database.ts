import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface SqliteStatement {
  run(...values: Array<string | number | bigint | null>): unknown;
  get(...values: Array<string | number | bigint | null>): Record<string, unknown> | undefined;
  all(...values: Array<string | number | bigint | null>): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function createDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
  });

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id           TEXT    PRIMARY KEY,
      url          TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      pages_visited   INTEGER NOT NULL DEFAULT 0,
      pages_failed    INTEGER NOT NULL DEFAULT 0,
      pages_discovered INTEGER NOT NULL DEFAULT 0,
      max_pages    INTEGER NOT NULL DEFAULT 100,
      seo_score    INTEGER,
      seo_report_json TEXT,
      started_at   INTEGER,
      completed_at INTEGER,
      duration_ms  INTEGER,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      export_status_json TEXT
    )
  `);

  const columns = db.prepare('PRAGMA table_info(crawl_jobs)').all();
  const columnNames = new Set(columns.map((column) => String(column.name)));
  if (!columnNames.has('seo_score')) {
    db.exec('ALTER TABLE crawl_jobs ADD COLUMN seo_score INTEGER;');
  }
  if (!columnNames.has('seo_report_json')) {
    db.exec('ALTER TABLE crawl_jobs ADD COLUMN seo_report_json TEXT;');
  }
  if (!columnNames.has('export_status_json')) {
    db.exec('ALTER TABLE crawl_jobs ADD COLUMN export_status_json TEXT;');
  }
  const additions: Array<[string, string]> = [
    ['builder_status', 'TEXT'], ['builder_error', 'TEXT'], ['site_url', 'TEXT'],
    ['site_port', 'INTEGER'], ['site_path', 'TEXT'], ['docker_started_at', 'INTEGER'],
    ['wordpress_ready_at', 'INTEGER'],
  ];
  for (const [name, type] of additions) {
    if (!columnNames.has(name)) db.exec(`ALTER TABLE crawl_jobs ADD COLUMN ${name} ${type};`);
  }

  // Batch rows deliberately live independently from crawl_jobs. A malformed
  // row, a paused batch or an API restart must never corrupt completed crawls.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_batches (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      url_column TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS crawl_batch_rows (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      business_name TEXT,
      source_url TEXT,
      normalized_url TEXT,
      classification TEXT NOT NULL,
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      selected INTEGER NOT NULL DEFAULT 1,
      crawl_job_id TEXT REFERENCES crawl_jobs(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(batch_id, row_number)
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_batch_rows_batch ON crawl_batch_rows(batch_id, classification, selected);
  `);

  return db;
}
