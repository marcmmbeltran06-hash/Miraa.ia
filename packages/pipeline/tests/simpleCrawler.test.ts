import { describe, expect, it, vi } from 'vitest';
import { SimpleCrawler } from '../src/adapters/SimpleCrawler.js';

const pageMap: Record<string, string> = {
  'https://example.com/': '<html><body><a href="/about">About</a><a href="https://example.com/contact">Contact</a></body></html>',
  'https://example.com/about': '<html><body><a href="/">Home</a></body></html>',
  'https://example.com/contact': '<html><body><a href="/privacy">Privacy</a></body></html>',
  'https://example.com/privacy': '<html><body>Privacy policy</body></html>',
};

describe('SimpleCrawler', () => {
  it('crawls same-origin links and returns snapshots', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const html = pageMap[url];
      if (!html) {
        throw new Error('not found');
      }
      return { statusCode: 200, html, finalUrl: url };
    });

    const crawler = new SimpleCrawler(fetcher);
    const snapshots = await crawler.crawl('https://example.com/', 3);

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((snapshot) => snapshot.url)).toEqual([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/contact',
    ]);
    expect(snapshots[0].links).toEqual([
      'https://example.com/about',
      'https://example.com/contact',
    ]);
  });

  it('respects maxPages and avoids external links', async () => {
    const fetcher = vi.fn(async (url: string) => ({ statusCode: 200, html: '<a href="https://external.com/">External</a>', finalUrl: url }));
    const crawler = new SimpleCrawler(fetcher);

    const snapshots = await crawler.crawl('https://example.com/', 1);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].links).toEqual([]);
  });
});
