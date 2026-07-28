import type { ConfigSource } from './Config.js';

export interface EnvironmentConfigSourceOptions {
  prefix?: string;
  include?: string[];
}

export class EnvironmentConfigSource implements ConfigSource {
  private readonly prefix: string;
  private readonly include?: Set<string>;

  constructor(options: EnvironmentConfigSourceOptions = {}) {
    this.prefix = options.prefix ?? '';
    this.include = options.include ? new Set(options.include) : undefined;
  }

  public async load(): Promise<Record<string, string | number | boolean>> {
    const result: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) {
        continue;
      }

      if (!key.startsWith(this.prefix)) {
        continue;
      }

      const normalizedKey = key.substring(this.prefix.length);
      if (this.include && !this.include.has(normalizedKey)) {
        continue;
      }

      result[normalizedKey] = this.parseValue(value);
    }

    return result;
  }

  private parseValue(value: string): string | number | boolean {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    const numberValue = Number(value);
    if (!Number.isNaN(numberValue) && value.trim() !== '') {
      return numberValue;
    }
    return value;
  }
}
