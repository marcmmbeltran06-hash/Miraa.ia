# @autowp/storage

A generic storage abstraction package with an in-memory adapter for application state.

## API

- `StorageAdapter<T>`: interface for storing typed values.
- `InMemoryStorage<T>`: simple memory-backed implementation.

## Usage

```ts
import { InMemoryStorage } from '@autowp/storage';

const storage = new InMemoryStorage<number>();
await storage.set('counter', 1);
const current = await storage.get('counter');
```
