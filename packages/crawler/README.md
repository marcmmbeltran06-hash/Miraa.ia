# @autowp/crawler

A web crawler package with Playwright-based browser support and configurable traversal.

## Features

- BFS and DFS traversal
- maximum depth control
- maximum page count
- global timeout and cancellation
- automatic retries
- rate limiting
- concurrent crawl queue
- duplicate URL elimination
- same-domain restrictions
- event-driven crawl lifecycle
- HTML parsing integration

## Usage

```ts
import { BrowserPool } from '@autowp/browser';
import { PlaywrightBrowserAdapter } from '@autowp/playwright-adapter';
import { WebCrawler } from '@autowp/crawler';
import { InMemoryEventBus } from '@autowp/event-bus';

const adapter = new PlaywrightBrowserAdapter({ engine: 'chromium' });
const pool = new BrowserPool({ adapter, maxSessions: 3 });
const bus = new InMemoryEventBus();

const crawler = new WebCrawler({
  startUrls: ['https://example.com'],
  browserPool: pool,
  eventBus: bus,
  concurrency: 3,
  strategy: 'bfs',
  maxDepth: 3,
  maxPages: 100,
});

await crawler.crawl();
```
