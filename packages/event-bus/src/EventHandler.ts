import type { DomainEvent } from './DomainEvent.js';

export type EventHandler<E extends DomainEvent = DomainEvent> = (
  event: E
) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}
