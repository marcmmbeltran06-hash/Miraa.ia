import { Website } from '@autowp/core-domain';
import type { EventBus } from '@autowp/event-bus';
import type { PipelineDependencies, PipelineOptions, PipelineResult } from './types.js';
import type { PipelineEvent } from './events.js';
import { PipelineError } from './errors.js';
import { PipelineCompleted, PipelineStarted } from './events.js';

export class Pipeline {
  public constructor(private readonly deps: PipelineDependencies) {}

  public async run(options: PipelineOptions): Promise<PipelineResult> {
    const { crawler, seoAnalyzer, eventBus, idGenerator, logger } = this.deps;

    if (!options.entryUrl || !/^https?:\/\//.test(options.entryUrl)) {
      throw new PipelineError('INVALID_INPUT', 'entryUrl must be a valid HTTP or HTTPS URL');
    }

    const startEvent: PipelineStarted = {
      type: 'PipelineStarted',
      payload: { entryUrl: options.entryUrl },
    };

    await this.publishEvent(eventBus, startEvent, logger);
    logger.info('Pipeline started', { entryUrl: options.entryUrl });

    const websiteId = idGenerator.generate();
    const websiteResult = Website.create(websiteId, options.entryUrl);

    if (!websiteResult.ok) {
      throw new PipelineError('INVALID_INPUT', websiteResult.error.message, websiteResult.error);
    }

    const website = websiteResult.value;
    const extractionResult = website.startExtraction();

    if (!extractionResult.ok) {
      throw new PipelineError('INVALID_INPUT', extractionResult.error.message, extractionResult.error);
    }

    const snapshots = await crawler.crawl(options.entryUrl, options.maxPages);
    const visitedPages = snapshots.length;
    const seoReport = seoAnalyzer.analyze({
      entryUrl: options.entryUrl,
      pages: snapshots.map((snapshot) => ({
        url: snapshot.url,
        finalUrl: snapshot.finalUrl,
        statusCode: snapshot.statusCode,
        html: snapshot.html,
        depth: snapshot.depth,
        responseTimeMs: snapshot.responseTimeMs,
        htmlSizeBytes: snapshot.htmlSizeBytes,
      })),
    });

    const completionResult = website.completeExtraction();
    if (!completionResult.ok) {
      throw new PipelineError('INVALID_INPUT', completionResult.error.message, completionResult.error);
    }

    const completedEvent: PipelineCompleted = {
      type: 'PipelineCompleted',
      payload: { entryUrl: options.entryUrl, visitedPages },
    };

    await this.publishEvent(eventBus, completedEvent, logger);
    logger.info('Pipeline completed', { entryUrl: options.entryUrl, visitedPages });

    return {
      websiteId: website.id.value,
      entryUrl: options.entryUrl,
      visitedPages,
      completedAt: new Date(),
      snapshots,
      seoReport,
    };
  }

  private async publishEvent(eventBus: EventBus, event: PipelineEvent, logger: { error(message: string, meta?: Record<string, unknown>): void }): Promise<void> {
    try {
      await eventBus.publish(event);
    } catch (error) {
      logger.error('Pipeline event publish failed', { eventType: event.type, error });
      throw new PipelineError('EVENT_BUS_FAILURE', 'Failed to publish pipeline event', error);
    }
  }
}
