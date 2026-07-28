import type { CrawlSnapshot, Crawler } from '../types.js';
import { extractSameOriginLinks, normalizeUrl } from '../utils.js';

export type Fetcher = (url: string) => Promise<{
  statusCode: number;
  html: string;
  finalUrl: string;
  responseTimeMs?: number;
}>;

export class SimpleCrawler implements Crawler {
  private readonly fetcher: Fetcher;

  public constructor(fetcher?: Fetcher) {
    this.fetcher = fetcher ?? this.defaultFetcher;
  }

  public async crawl(entryUrl: string, maxPages: number = 50): Promise<CrawlSnapshot[]> {
    const normalizedEntryUrl = normalizeUrl(entryUrl);
    const queue: Array<{ url: string; depth: number }> = [{ url: normalizedEntryUrl, depth: 0 }];
    const visited = new Set<string>();
    const snapshots: CrawlSnapshot[] = [];

    while (queue.length > 0 && snapshots.length < maxPages) {
      const item = queue.shift();
      if (!item || visited.has(item.url)) {
        continue;
      }

      visited.add(item.url);

      try {
        const fetchStart = Date.now();
        const response = await this.fetcher(item.url);
        const responseTimeMs = response.responseTimeMs ?? (Date.now() - fetchStart);
        const links = extractSameOriginLinks(response.html, response.finalUrl);
        const normalizedLinks = links.map((link) => normalizeUrl(link));

        normalizedLinks.forEach((link) => {
          if (!visited.has(link) && !queue.some((queued) => queued.url === link)) {
            queue.push({ url: link, depth: item.depth + 1 });
          }
        });

        snapshots.push({
          url: item.url,
          finalUrl: response.finalUrl,
          statusCode: response.statusCode,
          html: response.html,
          links: normalizedLinks,
          depth: item.depth,
          responseTimeMs,
          htmlSizeBytes: new TextEncoder().encode(response.html).length,
          discoveredAt: new Date(),
        });
      } catch {
        continue;
      }
    }

    return snapshots;
  }

  private async defaultFetcher(url: string): Promise<{ statusCode: number; html: string; finalUrl: string }> {
    const response = await fetch(url);
    const html = await response.text();

    return {
      statusCode: response.status,
      html,
      finalUrl: response.url,
    };
  }
}
