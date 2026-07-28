import { describe, expect, it } from 'vitest';
import { ConfigManager } from '../src/Config.js';
import { EnvironmentConfigSource } from '../src/EnvironmentConfigSource.js';
import { JsonFileConfigSource } from '../src/JsonFileConfigSource.js';
import { writeFile } from 'fs/promises';

const configFilePath = './tests/test-config.json';

describe('ConfigManager', () => {
  it('loads fallback values and overrides them with environment and JSON config', async () => {
    process.env.TEST_APP_NAME = 'env-app';
    const jsonSource = new JsonFileConfigSource({ filePath: configFilePath });
    const envSource = new EnvironmentConfigSource({ prefix: 'TEST_' });
    const manager = new ConfigManager({
      sources: [jsonSource, envSource],
      fallback: { APP_NAME: 'default-app', TIMEOUT: 100 },
    });

    await writeFile(configFilePath, JSON.stringify({ APP_NAME: 'json-app', TIMEOUT: 200 }));
    await manager.load();

    expect(manager.get<string>('APP_NAME')).toBe('env-app');
    expect(manager.get<number>('TIMEOUT')).toBe(200);
    expect(manager.get<boolean>('ENABLED', false)).toBe(false);
  });

  it('throws when accessing missing keys without fallback', async () => {
    const manager = new ConfigManager({ sources: [] });
    await manager.load();

    expect(() => manager.get('MISSING_KEY')).toThrow('Missing configuration key: MISSING_KEY');
  });
});
