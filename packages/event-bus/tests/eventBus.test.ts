import { describe, expect, it } from 'vitest';
import { EventBusError, InMemoryEventBus } from '../src/EventBus.js';
import type { DomainEvent } from '../src/DomainEvent.js';

interface TestEvent extends DomainEvent {
  type: 'TestEvent';
  payload: { value: number };
}

describe('InMemoryEventBus', () => {
  it('calls subscribed handlers for matching event types', async () => {
    const bus = new InMemoryEventBus();
    const received: number[] = [];

    bus.subscribe('TestEvent', (event: TestEvent) => {
      received.push(event.payload.value);
    });

    await bus.publish({ type: 'TestEvent', payload: { value: 42 } });

    expect(received).toEqual([42]);
  });

  it('does not call handlers for different event types', async () => {
    const bus = new InMemoryEventBus();
    let called = false;

    bus.subscribe('OtherEvent', () => {
      called = true;
    });

    await bus.publish({ type: 'TestEvent', payload: { value: 1 } });

    expect(called).toBe(false);
  });

  it('allows global subscriptions to receive all events', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    bus.subscribeAll((event: DomainEvent) => {
      received.push(event.type);
    });

    await bus.publish({ type: 'TestEvent', payload: { value: 1 } });
    await bus.publish({ type: 'OtherEvent', payload: { message: 'ok' } });

    expect(received).toEqual(['TestEvent', 'OtherEvent']);
  });

  it('supports unsubscribing from event types', async () => {
    const bus = new InMemoryEventBus();
    let called = false;

    const subscription = bus.subscribe('TestEvent', () => {
      called = true;
    });

    subscription.unsubscribe();
    await bus.publish({ type: 'TestEvent', payload: { value: 1 } });

    expect(called).toBe(false);
  });

  it('throws EventBusError when a handler rejects', async () => {
    const bus = new InMemoryEventBus();

    bus.subscribe('TestEvent', async () => {
      throw new Error('handler failure');
    });

    await expect(async () => {
      await bus.publish({ type: 'TestEvent', payload: { value: 1 } });
    }).rejects.toThrow(EventBusError);
  });
});
