import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/Database';
import { SqliteCrawlRepository } from '../src/SqliteCrawlRepository';
import type { CrawlRecord } from '../src/types';
import type { SqliteDatabase } from '../src/Database';

const BASE: Omit<CrawlRecord, 'id' | 'url'> = {
  status: 'pending',
  pagesVisited: 0,
  pagesFailed: 0,
  pagesDiscovered: 0,
  maxPages: 100,
  seoScore: null,
  seoReportJson: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  error: null,
  createdAt: Date.now(),
};

describe('SqliteCrawlRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteCrawlRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    repo = new SqliteCrawlRepository(db);
  });

  it('creates and retrieves a record', async () => {
    await repo.create({ ...BASE, id: 'a', url: 'https://example.com' });
    const found = await repo.findById('a');
    expect(found).toBeDefined();
    expect(found?.url).toBe('https://example.com');
    expect(found?.status).toBe('pending');
  });

  it('returns undefined for missing id', async () => {
    const found = await repo.findById('nope');
    expect(found).toBeUndefined();
  });

  it('updates status and counters', async () => {
    await repo.create({ ...BASE, id: 'b', url: 'https://example.com' });
    await repo.update('b', { status: 'running', pagesVisited: 3, pagesDiscovered: 5 });
    const found = await repo.findById('b');
    expect(found?.status).toBe('running');
    expect(found?.pagesVisited).toBe(3);
    expect(found?.pagesDiscovered).toBe(5);
  });

  it('stores and retrieves error', async () => {
    await repo.create({ ...BASE, id: 'c', url: 'https://example.com' });
    await repo.update('c', { status: 'failed', error: 'timeout' });
    const found = await repo.findById('c');
    expect(found?.status).toBe('failed');
    expect(found?.error).toBe('timeout');
  });

  it('stores and retrieves SEO report data', async () => {
    await repo.create({ ...BASE, id: 'seo', url: 'https://example.com' });
    await repo.update('seo', {
      status: 'completed',
      seoScore: 83,
      seoReportJson: '{"score":83,"pages":[]}',
    });
    const found = await repo.findById('seo');
    expect(found?.seoScore).toBe(83);
    expect(found?.seoReportJson).toBe('{"score":83,"pages":[]}');
  });

  it('findAll returns all records ordered by created_at DESC', async () => {
    const now = Date.now();
    await repo.create({ ...BASE, id: 'x', url: 'https://x.com', createdAt: now });
    await repo.create({ ...BASE, id: 'y', url: 'https://y.com', createdAt: now + 1 });
    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('y');
    expect(all[1].id).toBe('x');
  });

  it('no-ops update with empty patch', async () => {
    await repo.create({ ...BASE, id: 'd', url: 'https://example.com' });
    await expect(repo.update('d', {})).resolves.toBeUndefined();
    const found = await repo.findById('d');
    expect(found?.status).toBe('pending');
  });
});
