import { describe, it, expect } from 'vitest';
import { CrawlJobRunner } from '../src/CrawlJobRunner';
import type { BrowserPoolFactory, WordPressSiteController } from '../src/CrawlJobRunner';
import { DefaultSeoAnalyzer } from '@autowp/seo-analyzer';
import { NoopLogger } from '@autowp/logger';
import type { BrowserPool } from '@autowp/browser';
import type { CrawlRepository, CrawlRecord } from '@autowp/database';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

class InMemoryCrawlRepository implements CrawlRepository {
  private readonly records = new Map<string, CrawlRecord>();

  async create(record: CrawlRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async update(id: string, patch: Partial<Omit<CrawlRecord, 'id' | 'createdAt'>>): Promise<void> {
    const current = this.records.get(id);
    if (current) this.records.set(id, { ...current, ...patch });
  }

  async findById(id: string): Promise<CrawlRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async findAll(): Promise<CrawlRecord[]> {
    return [...this.records.values()];
  }
}

function makePoolFactory(html: Map<string, string>): BrowserPoolFactory {
  const pool = {
    acquire: async () => {
      let currentUrl = '';
      return {
        page: {
          goto: async (url: string) => {
            currentUrl = url;
            return { status: () => 200 };
          },
          content: async () => html.get(currentUrl) ?? '<html><body></body></html>',
          evaluate: async () => {},
        },
      };
    },
    release: async () => {},
    close: async () => {},
  };
  return { create: () => pool as unknown as BrowserPool<unknown> };
}

async function waitForFinal(runner: CrawlJobRunner, jobId: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const status = await runner.getStatus(jobId);
    if (status && ['ready', 'needs_reconstruction', 'failed', 'cancelled'].includes(status.status)) {
      return status.status;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Job did not finalize in time (last status: ${status?.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('CrawlJobRunner end-to-end', () => {
  it('captures the site and starts the WordPress constructor automatically', async () => {
    const html = new Map<string, string>([
      [
        'https://example.com',
        `<html><head><title>Home</title>
          <meta name="description" content="A home page with enough descriptive text to pass validation." /></head>
          <body>
            <a href="/about">About</a>
            <a href="/catalog.pdf">Catalog</a>
            <img src="/logo.png" />
          </body></html>`,
      ],
      [
        'https://example.com/about',
        `<html><head><title>About</title>
          <meta name="description" content="About page with a reasonably long description for SEO checks." /></head>
          <body><h1>About us</h1></body></html>`,
      ],
    ]);

    const repository = new InMemoryCrawlRepository();
    const starts: string[] = [];
    const sites: WordPressSiteController = {
      start: async (jobId) => {
        starts.push(jobId);
        await repository.update(jobId, {
          status: 'ready',
          builderStatus: 'ready',
          siteUrl: 'http://127.0.0.1:8080',
          sitePort: 8080,
        });
        return true;
      },
      restart: async () => true,
      rerunValidation: async () => true,
      stop: async () => true,
    };
    const runner = new CrawlJobRunner(
      repository,
      makePoolFactory(html),
      new NoopLogger(),
      new DefaultSeoAnalyzer(),
      50,
      sites,
    );

    const jobId = await runner.submit('https://example.com');
    const finalStatus = await waitForFinal(runner, jobId);

    expect(finalStatus).toBe('ready');
    expect(starts).toEqual([jobId]);

    const record = await repository.findById(jobId);
    expect(record?.seoReportJson).not.toBeNull();
    const report = JSON.parse(record?.seoReportJson ?? '{"pages":[]}') as { pages: Array<{ url: string }> };
    const reportedUrls = report.pages.map((page) => page.url);
    expect(reportedUrls).not.toContain('https://example.com/catalog.pdf');
    expect(record?.exportStatusJson).not.toBeNull();
    const exportDirectory = path.resolve('auditoria', jobId);
    expect(existsSync(path.join(exportDirectory, 'wordpress', 'index.json'))).toBe(true);
    expect(existsSync(path.join(exportDirectory, 'products.json'))).toBe(true);
    expect(existsSync(path.join(exportDirectory, 'woocommerce-products.csv'))).toBe(true);
  });
});
