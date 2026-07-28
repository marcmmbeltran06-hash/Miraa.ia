// AggregateRoot.ts
import { Entity } from "./Entity.js";
import { DomainEvent } from "./DomainEvent.js";
import { Identifier } from "@autowp/shared";

/**
 * Base class for Aggregate Roots implementing simple Event Sourcing.
 * It extends Entity and maintains a private list of domain events.
 */
export abstract class AggregateRoot extends Entity {
  private _events: DomainEvent[] = [];

  protected constructor(id: Identifier) {
    super(id);
  }

  /** Accumulate a domain event */
  protected raise(event: DomainEvent): void {
    this._events.push(event);
  }

  /** Retrieve and clear accumulated events */
  public pullEvents(): DomainEvent[] {
    const events = [...this._events];
    this._events = [];
    return events;
  }
}
