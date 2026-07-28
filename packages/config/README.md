# @autowp/config

A configuration management package supporting environment variables and JSON files.

## API

- `ConfigManager`: loads values from config sources and validates required keys.
- `ConfigSource`: abstraction for configuration providers.
- `EnvironmentConfigSource`: reads values from `process.env`.
- `JsonFileConfigSource`: loads values from a JSON file.

## Usage

```ts
import { ConfigManager, EnvironmentConfigSource, JsonFileConfigSource } from '@autowp/config';

const manager = new ConfigManager([
  new JsonFileConfigSource('./config.json'),
  new EnvironmentConfigSource(),
]);

const config = await manager.getConfig(['NODE_ENV', 'API_KEY']);
```
