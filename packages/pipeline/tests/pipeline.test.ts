import { describe, expect, it } from 'vitest';
import { Pipeline } from '../src/Pipeline.js';
import { Identifier, ConsoleLogger } from '@autowp/shared';
import type { CrawlSnapshot } from '../src/types.js';
import type { SeoAnalyzerInput, SeoReport } from '@autowp/seo-analyzer';

class StubCrawler {
  public async crawl(): Promise<CrawlSnapshot[]> {
    return [
      {
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        statusCode: 200,
        html: '<html></html>',
        links: [],
        depth: 0,
        discoveredAt: new Date(),
      },
    ];
  }
}

class StubEventBus {
  public readonly published: Array<{ type: string; payload?: unknown }> = [];

  public async publish(event: { type: string; payload?: unknown }): Promise<void> {
    this.published.push(event);
  }
}

class StubSeoAnalyzer {
  public analyze(_input: SeoAnalyzerInput): SeoReport {
    return {
      score: 88,
      criticalErrors: [],
      warnings: [],
      info: [],
      summary: {
        totalPages: 1,
        redirects: 0,
        brokenLinks: 0,
        pagesWithoutTitle: 0,
        pagesWithoutDescription: 0,
        duplicateTitles: [],
        duplicateDescriptions: [],
      },
      pages: [],
    };
  }
}

describe('Pipeline', () => {
  it('runs the pipeline and emits start/completion events', async () => {
    const crawler = new StubCrawler();
    const seoAnalyzer = new StubSeoAnalyzer();
    const eventBus = new StubEventBus();
    const idGenerator = { generate: () => Identifier.create('website-123') };
    const logger = new ConsoleLogger();

    const pipeline = new Pipeline({
      crawler,
      seoAnalyzer,
      eventBus,
      idGenerator,
      logger,
    });

    const result = await pipeline.run({ entryUrl: 'https://example.com' });

    expect(result.websiteId).toBe('website-123');
    expect(result.entryUrl).toBe('https://example.com');
    expect(result.visitedPages).toBe(1);
    expect(result.seoReport.score).toBe(88);
    expect(eventBus.published.map((event) => event.type)).toEqual([
      'PipelineStarted',
      'PipelineCompleted',
    ]);
  });
});
