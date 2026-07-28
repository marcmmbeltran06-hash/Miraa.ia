// Page.ts
import { Entity } from "./Entity.js";
import { Identifier } from "@autowp/shared";
import { Result, ok, err } from "@autowp/shared";
import { DomainError } from "@autowp/shared";

export type PageType = "home" | "collection" | "product" | "unknown";

/**
 * Entity representing a crawled page.
 */
export class Page extends Entity {
  public readonly url: string;
  public readonly html: string;
  public readonly pageType: PageType;

  private constructor(id: Identifier, url: string, html: string, pageType: PageType) {
    super(id);
    this.url = url;
    this.html = html;
    this.pageType = pageType;
  }

  public static create(
    id: Identifier,
    url: string,
    html: string,
    pageType: PageType = "unknown"
  ): Result<Page, DomainError> {
    if (!url || !/^https?:\/\//.test(url)) {
      return err(new DomainError("Invalid page URL"));
    }
    return ok(new Page(id, url, html, pageType));
  }
}
