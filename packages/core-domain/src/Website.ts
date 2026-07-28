// Website.ts
import { AggregateRoot } from "./AggregateRoot.js";
import { Identifier } from "@autowp/shared";
import { Result, ok, err } from "@autowp/shared";
import { DomainError } from "@autowp/shared";

/**
 * AggregateRoot representing a website extraction process.
 */
export class Website extends AggregateRoot {
  public readonly url: string;
  public readonly metadata: Record<string, unknown>;
  private _state: "pending" | "in_progress" | "completed" = "pending";

  private constructor(id: Identifier, url: string, metadata: Record<string, unknown>) {
    super(id);
    this.url = url;
    this.metadata = metadata;
  }

  /** Factory method that validates URL and creates a Website */
  public static create(
    id: Identifier,
    url: string,
    metadata: Record<string, unknown> = {}
  ): Result<Website, DomainError> {
    if (!url || !/^https?:\/\//.test(url)) {
      return err(new DomainError("Invalid website URL"));
    }
    return ok(new Website(id, url, metadata));
  }

  /** Start the extraction process, raising an event */
  public startExtraction(): Result<void, DomainError> {
    if (this._state !== "pending") {
      return err(new DomainError("Extraction already started"));
    }
    this._state = "in_progress";
    this.raise({
      type: "WebsiteExtractionStarted",
      payload: { websiteId: this.id.value, url: this.url },
    });
    return ok(undefined);
  }

  /** Mark extraction as completed */
  public completeExtraction(): Result<void, DomainError> {
    if (this._state !== "in_progress") {
      return err(new DomainError("Extraction not in progress"));
    }
    this._state = "completed";
    // Could raise a "WebsiteExtractionCompleted" event if desired
    return ok(undefined);
  }

  public get state() {
    return this._state;
  }
}
