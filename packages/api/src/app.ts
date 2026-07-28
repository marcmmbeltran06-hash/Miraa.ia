/**
 * Composition root — wires all packages together and starts the HTTP server.
 * This file is NOT exported by index.ts; it is the application entry-point.
 *
 * Usage: node dist/app.js
 */
import { PlaywrightBrowserAdapter } from '@autowp/playwright-adapter';
import { BrowserPool } from '@autowp/browser';
import { createDatabase, SqliteCrawlRepository } from '@autowp/database';
import { ConsoleLogger } from '@autowp/logger';
import { DefaultSeoAnalyzer } from '@autowp/seo-analyzer';
import { buildApp } from './ApiServer.js';
import { CrawlJobRunner, adapterFactory } from './CrawlJobRunner.js';

const logger = new ConsoleLogger({ level: 'info', includeTimestamp: true });
const dbPath = process.env.DATABASE_PATH ?? './crawl.db';
const port = Number(process.env.PORT ?? 3000);
const maxPages = Number(process.env.MAX_PAGES ?? 100);

const db = createDatabase(dbPath);
const repository = new SqliteCrawlRepository(db);

const pool_factory = adapterFactory(
  () => new PlaywrightBrowserAdapter({ engine: 'chromium' }),
  3,
);

const jobService = new CrawlJobRunner(repository, pool_factory, logger, new DefaultSeoAnalyzer(), maxPages);
const app = buildApp(jobService, { logger: false });

await app.listen({ port, host: '0.0.0.0' });
logger.info(`API server listening`, { port });

// Only recover stale workers after this process owns the API port. A second
// accidental launch must fail with EADDRINUSE without modifying jobs that are
// still being processed by the already-running API instance.
const staleJobs = await repository.findNonTerminal();
for (const job of staleJobs) {
  await repository.update(job.id, {
    status: 'partially_completed',
    completedAt: Date.now(),
    error: 'API_RESTART_RECOVERY: worker stopped; existing artifacts are preserved and the failed stage can be retried.',
  });
}
if (staleJobs.length > 0) logger.info('Recovery completed', { recovered: staleJobs.length });

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception; initiating controlled shutdown', { error: error.stack ?? error.message });
  void app.close().finally(() => { db.close(); process.exit(1); });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection; initiating controlled shutdown', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  void app.close().finally(() => { db.close(); process.exit(1); });
});

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down`);
    await app.close();
    db.close();
    process.exit(0);
  });
}

// Expose for testing/programmatic use
export { app, BrowserPool };
