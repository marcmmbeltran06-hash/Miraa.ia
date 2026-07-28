import type { HtmlParseResult } from '@autowp/html-parser';

export interface PageDiscoveredEvent {
  type: 'PageDiscovered';
  payload: {
    url: string;
    depth: number;
    sourceUrl?: string;
  };
}

export interface PageVisitedEvent {
  type: 'PageVisited';
  payload: {
    url: string;
    depth: number;
    status: number;
    durationMs: number;
  };
}

export interface PageParsedEvent {
  type: 'PageParsed';
  payload: {
    url: string;
    depth: number;
    parse: HtmlParseResult;
  };
}

export interface PageFailedEvent {
  type: 'PageFailed';
  payload: {
    url: string;
    depth: number;
    attempt: number;
    error: string;
  };
}

export interface AssetFoundEvent {
  type: 'AssetFound';
  payload: {
    url: string;
    pageUrl: string;
    type: 'image' | 'script' | 'stylesheet' | 'font' | 'media' | 'document' | 'other';
  };
}

export interface CrawlerFinishedEvent {
  type: 'CrawlerFinished';
  payload: {
    pagesVisited: number;
    pagesFailed: number;
    pagesDiscovered: number;
    durationMs: number;
    cancelled: boolean;
  };
}

export type CrawlerEvent =
  | PageDiscoveredEvent
  | PageVisitedEvent
  | PageParsedEvent
  | PageFailedEvent
  | AssetFoundEvent
  | CrawlerFinishedEvent;
