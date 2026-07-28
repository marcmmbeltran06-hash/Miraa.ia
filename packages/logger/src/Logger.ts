export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  includeTimestamp?: boolean;
}

export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly includeTimestamp: boolean;
  private readonly levelPriorities: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'debug';
    this.includeTimestamp = options.includeTimestamp ?? true;
  }

  debug(message: string, meta: Record<string, unknown> = {}): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta: Record<string, unknown> = {}): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta: Record<string, unknown> = {}): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta: Record<string, unknown> = {}): void {
    this.log('error', message, meta);
  }

  private log(level: LogLevel, message: string, meta: Record<string, unknown>): void {
    if (this.levelPriorities[level] < this.levelPriorities[this.level]) {
      return;
    }
    const payload = {
      level,
      message,
      ...(this.includeTimestamp ? { timestamp: new Date().toISOString() } : {}),
      ...meta,
    };
    console.log(JSON.stringify(payload));
  }
}

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
