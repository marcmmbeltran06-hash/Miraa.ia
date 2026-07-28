import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { CrawlJobService } from './types.js';
import { healthRoutes } from './routes/health.js';
import { crawlRoutes } from './routes/crawl.js';
import { ReportShareStore } from './ReportShareStore.js';
import { campaignRoutes } from './routes/campaign.js';

export interface ApiServerOptions {
  logger?: boolean | Record<string, unknown>;
}

export function buildApp(
  service: CrawlJobService,
  options: ApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.addContentTypeParser(
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: 30 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }

    return undefined;
  });

  void app.register(healthRoutes);
  void app.register(crawlRoutes, { service, shareStore: new ReportShareStore() });
  void app.register(campaignRoutes);

  return app;
}
