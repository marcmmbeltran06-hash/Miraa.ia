# @autowp/event-bus

`@autowp/event-bus` provides a lightweight, in-memory event bus for domain events.
It is designed to support Hexagonal architecture by decoupling publisher modules from subscribers.

## Features

- Typed `DomainEvent` interface
- Event handlers for specific event types
- Global subscribers for all events
- Unsubscribe support
- Handler error aggregation with `EventBusError`

## Public API

- `EventBus`
- `InMemoryEventBus`
- `EventBusError`
- `DomainEvent`
- `EventHandler`
- `Subscription`

## Example

```ts
import { InMemoryEventBus } from '@autowp/event-bus';

const eventBus = new InMemoryEventBus();

const subscription = eventBus.subscribe('PipelineCompleted', (event) => {
  console.log('Pipeline completed', event.payload);
});

await eventBus.publish({ type: 'PipelineCompleted', payload: { visitedPages: 5 } });

subscription.unsubscribe();
```
