export interface ConfigSource {
  load(): Promise<Record<string, string | number | boolean>>;
}

export interface ConfigManagerOptions {
  sources: ConfigSource[];
  fallback?: Record<string, string | number | boolean>;
}

export class ConfigManager {
  private readonly sources: ConfigSource[];
  private readonly fallback: Record<string, string | number | boolean>;
  private config: Record<string, string | number | boolean> | null = null;

  constructor(options: ConfigManagerOptions) {
    this.sources = options.sources;
    this.fallback = options.fallback ?? {};
  }

  public async load(): Promise<void> {
    const values = { ...this.fallback };

    for (const source of this.sources) {
      const loaded = await source.load();
      Object.assign(values, loaded);
    }

    this.config = values;
  }

  public get<T extends string | number | boolean>(key: string, fallback?: T): T {
    if (!this.config) {
      throw new Error('ConfigManager must be loaded before reading values');
    }

    if (key in this.config) {
      return this.config[key] as T;
    }

    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(`Missing configuration key: ${key}`);
  }

  public has(key: string): boolean {
    return !!this.config && key in this.config;
  }
}
