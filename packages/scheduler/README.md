# @autowp/scheduler

A lightweight scheduler package that defers work execution and integrates with the queue abstraction.

## API

- `Scheduler`: interface for scheduled tasks.
- `SimpleScheduler`: scheduler implementation with optional queue dispatch.

## Usage

```ts
import { SimpleScheduler } from '@autowp/scheduler';
import { InMemoryQueue } from '@autowp/queue';

const queue = new InMemoryQueue();
const scheduler = new SimpleScheduler({ queue });

const id = scheduler.scheduleAfter(1000, () => {
  console.log('executed');
});

scheduler.cancel(id);
```
