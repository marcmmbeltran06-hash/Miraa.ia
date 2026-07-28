import { describe, expect, it } from 'vitest';
import { WebCrawler } from '../src/Crawler';
import { InMemoryEventBus } from '@autowp/event-bus';
import type { BrowserPool } from '@autowp/browser';
process.env.NODE_ENV = 'test';

class MockPage {
  private currentUrl = '';
  private readonly pages: Map<string, string>;

  constructor(pages: Map<string, string>) {
    this.pages = pages;
  }

  public async goto(url: string) {
    this.currentUrl = url;
    return { status: 200 };
  }

  public async content(): Promise<string> {
    return this.pages.get(this.currentUrl) ?? '<html></html>';
  }
}

class MockBrowserPool implements BrowserPool<unknown> {
  private readonly page: MockPage;

  constructor(page: MockPage) {
    this.page = page;
  }

  public async acquire(): Promise<unknown> {
    return { page: this.page };
  }
  public async release(): Promise<void> { return; }
  public async close(): Promise<void> { return; }
}

describe('WebCrawler', () => {
  it('crawls internal pages and emits events', async () => {
    const htmlMap = new Map<string, string>([
      [
        'https://example.com',
        '<html><head><title>Home</title></head><body><a href="/about">About</a><img src="/logo.png" /></body></html>',
      ],
      [
        'https://example.com/about',
        '<html><head><title>About</title></head><body><a href="https://external.com/other">External</a></body></html>',
      ],
    ]);
    const page = new MockPage(htmlMap);
    const browserPool = new MockBrowserPool(page);
    const eventBus = new InMemoryEventBus();
    const events: string[] = [];
    eventBus.subscribeAll((e) => events.push(e.type));

    process.env.NODE_ENV = 'test';
    const crawler = new WebCrawler({
      startUrls: ['https://example.com'],
      browserPool: browserPool as unknown as BrowserPool<unknown>,
      eventBus,
      concurrency: 2,
      strategy: 'bfs',
      maxDepth: 2,
      maxPages: 10,
      stagnationLimit: 1,
      rateLimitMs: 0,
      excludeExternalDomains: true,
    });

    const result = await crawler.crawl();
    expect(result.pagesVisited).toBe(2);
    expect(result.pagesDiscovered).toBe(2);
    expect(result.cancelled).toBe(false);
    expect(events).toContain('PageVisited');
    expect(events).toContain('PageParsed');
    expect(events).toContain('AssetFound');
    expect(events).toContain('CrawlerFinished');
  });

  it('crawls all pages without maxPages limit', { timeout: 20000 }, async () => {
    const htmlMap = new Map<string, string>([
      ['https://example.com', '<html><body><a href="/a">A</a><a href="/b">B</a></body></html>'],
      ['https://example.com/a', '<html><body></body></html>'],
      ['https://example.com/b', '<html><body></body></html>'],
    ]);
    const page = new MockPage(htmlMap);
    const browserPool = new MockBrowserPool(page);
    const eventBus = new InMemoryEventBus();

    const crawler = new WebCrawler({
      startUrls: ['https://example.com'],
      browserPool: browserPool as unknown as BrowserPool<unknown>,
      eventBus,
      concurrency: 1,
      strategy: 'bfs',
      maxDepth: 2,
      maxPages: 1, // ignored by crawler logic
      stagnationLimit: 1,
      rateLimitMs: 0,
      excludeExternalDomains: true,
    });

    const result = await crawler.crawl();

    expect(result.pagesVisited).toBe(3);
    expect(result.pagesFailed).toBe(0);
    expect(result.pagesDiscovered).toBe(3);
  });

  it('registers asset links as resources and never crawls them as pages', async () => {
    const htmlMap = new Map<string, string>([
      [
        'https://example.com',
        '<html><body>' +
          '<a href="/about">About</a>' +
          '<a href="/catalog.pdf">Catalog</a>' +
          '<a href="/gallery/photo.jpg">Photo</a>' +
          '<a href="https://cdn.example.com/app.js">CDN</a>' +
          '</body></html>',
      ],
      ['https://example.com/about', '<html><body></body></html>'],
    ]);
    const page = new MockPage(htmlMap);
    const browserPool = new MockBrowserPool(page);
    const eventBus = new InMemoryEventBus();
    const assetUrls: string[] = [];
    const visitedUrls: string[] = [];
    eventBus.subscribeAll((e) => {
      if (e.type === 'AssetFound') assetUrls.push((e.payload as { url: string }).url);
      if (e.type === 'PageVisited') visitedUrls.push((e.payload as { url: string }).url);
    });

    const crawler = new WebCrawler({
      startUrls: ['https://example.com'],
      browserPool: browserPool as unknown as BrowserPool<unknown>,
      eventBus,
      concurrency: 2,
      stagnationLimit: 1,
      rateLimitMs: 0,
      excludeExternalDomains: true,
    });

    const result = await crawler.crawl();

    // Only the two navigable pages count as knowledge.
    expect(result.pagesVisited).toBe(2);
    expect(result.pagesDiscovered).toBe(2);
    expect(result.cancelled).toBe(false);
    // Asset anchors are recorded as resources, not crawled as pages.
    expect(assetUrls).toContain('https://example.com/catalog.pdf');
    expect(assetUrls).toContain('https://example.com/gallery/photo.jpg');
    expect(visitedUrls).not.toContain('https://example.com/catalog.pdf');
    expect(visitedUrls).not.toContain('https://example.com/gallery/photo.jpg');
  });

  it('timeout safety-net fires when workers are stuck', { timeout: 15000 }, async () => {
    // The timeout acts as a last-resort circuit breaker for stuck workers
    // (e.g. pages whose navigation never resolves). It clears all pending
    // work instead of cancelling, so the crawl completes with a diagnostic.
    const hangingPool: BrowserPool<unknown> = {
      acquire: async () => ({ page: { goto: () => new Promise(() => {}), content: async () => '<html></html>' } }),
      release: async () => {},
      close: async () => {},
    } as unknown as BrowserPool<unknown>;

    const crawler = new WebCrawler({
      startUrls: ['https://example.com'],
      browserPool: hangingPool,
      eventBus: new InMemoryEventBus(),
      concurrency: 1,
      retryCount: 0,
      timeoutMs: 300,
      stabilityWindowMs: 100000,
      rateLimitMs: 0,
    });

    const result = await crawler.crawl();
    expect(result.cancelled).toBe(false);
    expect(result.terminationReason).toBe('timeout_safety_net');
  });

  it('timeout safety-net handles multiple stuck workers', { timeout: 15000 }, async () => {
    // Three start URLs with concurrency 1 and hanging pages: the timeout
    // clears all pending work as a last resort. All workers are stuck so
    // the safety net fires.
    const hangingPool: BrowserPool<unknown> = {
      acquire: async () => ({ page: { goto: () => new Promise(() => {}), content: async () => '<html></html>' } }),
      release: async () => {},
      close: async () => {},
    } as unknown as BrowserPool<unknown>;

    const crawler = new WebCrawler({
      startUrls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
      browserPool: hangingPool,
      eventBus: new InMemoryEventBus(),
      concurrency: 1,
      retryCount: 0,
      timeoutMs: 300,
      stabilityWindowMs: 100000,
      rateLimitMs: 0,
    });

    const result = await crawler.crawl();
    expect(result.cancelled).toBe(false);
    expect(result.terminationReason).toBe('timeout_safety_net');
  });

  it('pauses discovery on stagnation but does not cancel or discard pending URLs', { timeout: 15000 }, async () => {
    const htmlMap = new Map<string, string>([
      [
        'https://example.com',
        '<html><body><a href="/page?sort=a">A</a><a href="/page?sort=b">B</a><a href="/page?sort=c">C</a></body></html>',
      ],
      [
        'https://example.com/page',
        '<html><body><a href="/page?sort=d">D</a><a href="/page?sort=e">E</a></body></html>',
      ],
    ]);
    const page = new MockPage(htmlMap);
    const browserPool = new MockBrowserPool(page);
    const eventBus = new InMemoryEventBus();

    const crawler = new WebCrawler({
      startUrls: ['https://example.com'],
      browserPool: browserPool as unknown as BrowserPool<unknown>,
      eventBus,
      concurrency: 1,
      strategy: 'bfs',
      maxDepth: 2,
      maxPages: 100,
      stagnationLimit: 2,
      stabilityWindowMs: 200,
      rateLimitMs: 0,
      excludeExternalDomains: true,
    });

    const result = await crawler.crawl();
    expect(result.cancelled).toBe(false);
    expect(result.terminationReason).toBeDefined();
    expect(result.pendingDiscarded ?? 0).toBe(0);
    expect(result.pagesVisited).toBeGreaterThan(0);
  });
});
