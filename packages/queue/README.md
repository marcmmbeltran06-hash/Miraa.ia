# @autowp/queue

A simple task queue with configurable concurrency for asynchronous work.

## API

- `Queue<T>`: queue abstraction for enqueuing tasks.
- `InMemoryQueue<T>`: in-memory implementation with concurrency and drain semantics.

## Usage

```ts
import { InMemoryQueue } from '@autowp/queue';

const queue = new InMemoryQueue<number>(3);
await queue.enqueue(async () => {
  return 42;
});
await queue.drain();
```
