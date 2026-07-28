import type { DomainEvent } from './DomainEvent.js';
import type { EventHandler, Subscription } from './EventHandler.js';

export interface EventBus {
  publish<E extends DomainEvent>(event: E): Promise<void>;
  subscribe<E extends DomainEvent>(type: E['type'], handler: EventHandler<E>): Subscription;
  subscribeAll(handler: EventHandler<DomainEvent>): Subscription;
}

export class EventBusError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EventBusError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Array<EventHandler<DomainEvent>>>();
  private readonly globalHandlers: Array<EventHandler<DomainEvent>> = [];

  public async publish<E extends DomainEvent>(event: E): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    const allHandlers = [...handlers, ...this.globalHandlers];

    const results = await Promise.allSettled(
      allHandlers.map((handler) => handler(event))
    );

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);

    if (errors.length > 0) {
      throw new EventBusError('One or more event handlers failed', errors);
    }
  }

  public subscribe<E extends DomainEvent>(
    type: E['type'],
    handler: EventHandler<E>
  ): Subscription {
    const wrappedHandler = handler as EventHandler<DomainEvent>;
    const existing = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...existing, wrappedHandler]);

    return {
      unsubscribe: () => {
        const current = this.handlers.get(type) ?? [];
        this.handlers.set(
          type,
          current.filter((item) => item !== wrappedHandler)
        );
      },
    };
  }

  public subscribeAll(handler: EventHandler<DomainEvent>): Subscription {
    this.globalHandlers.push(handler);

    return {
      unsubscribe: () => {
        const index = this.globalHandlers.indexOf(handler);
        if (index !== -1) {
          this.globalHandlers.splice(index, 1);
        }
      },
    };
  }
}
