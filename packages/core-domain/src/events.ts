// events.ts
import { DomainEvent } from "./DomainEvent.js";
import { Asset } from "./Asset.js";
import { Variant } from "./Variant.js";

/** Event emitted when website extraction starts */
export interface WebsiteExtractionStarted extends DomainEvent {
  type: "WebsiteExtractionStarted";
  payload: {
    websiteId: string; // Identifier value
    url: string;
  };
}

/** Event emitted when a page is crawled */
export interface PageCrawled extends DomainEvent {
  type: "PageCrawled";
  payload: {
    websiteId: string;
    pageId: string;
    url: string;
    pageType: "home" | "collection" | "product" | "unknown";
  };
}

/** Event emitted when a product is detected */
export interface ProductDetected extends DomainEvent {
  type: "ProductDetected";
  payload: {
    websiteId: string;
    productId: string;
    name: string;
    price: number;
    currency: string;
    images: Asset[];
    variants: Variant[];
  };
}
