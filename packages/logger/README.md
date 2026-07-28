# @autowp/logger

A lightweight logger package for the AutoWP framework.

## Features

- pluggable `Logger` interface
- console logger with log-level filtering
- no-op logger for test or silent environments

## Usage

```ts
import { ConsoleLogger, NoopLogger } from '@autowp/logger';

const logger = new ConsoleLogger({ level: 'info' });
logger.info('Application started');
```

## API

- `Logger` interface
- `ConsoleLogger` implementation
- `NoopLogger` implementation
