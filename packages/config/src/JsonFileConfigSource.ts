import { readFile } from 'fs/promises';
import type { ConfigSource } from './Config.js';

export interface JsonFileConfigSourceOptions {
  filePath: string;
}

export class JsonFileConfigSource implements ConfigSource {
  private readonly filePath: string;

  constructor(options: JsonFileConfigSourceOptions) {
    this.filePath = options.filePath;
  }

  public async load(): Promise<Record<string, string | number | boolean>> {
    const raw = await readFile(this.filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, this.normalizeValue(value)])
    );
  }

  private normalizeValue(value: unknown): string | number | boolean {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      return value;
    }
    throw new Error(`Unsupported JSON config value type for value: ${JSON.stringify(value)}`);
  }
}
