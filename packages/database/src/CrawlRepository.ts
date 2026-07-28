import type { CrawlRecord } from './types.js';

export interface CrawlRepository {
  create(record: CrawlRecord): Promise<void>;
  update(id: string, patch: Partial<Omit<CrawlRecord, 'id' | 'createdAt'>>): Promise<void>;
  findById(id: string): Promise<CrawlRecord | undefined>;
  findSummaryById?(id: string): Promise<CrawlRecord | undefined>;
  findAll(): Promise<CrawlRecord[]>;
  findNonTerminal?(): Promise<CrawlRecord[]>;
}
