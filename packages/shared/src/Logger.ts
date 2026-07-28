// Logger.ts
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class ConsoleLogger implements Logger {
  debug(msg: string, meta?: Record<string, unknown>) {
    console.debug('[DEBUG]', msg, meta ?? {});
  }
  info(msg: string, meta?: Record<string, unknown>) {
    console.info('[INFO]', msg, meta ?? {});
  }
  warn(msg: string, meta?: Record<string, unknown>) {
    console.warn('[WARN]', msg, meta ?? {});
  }
  error(msg: string, meta?: Record<string, unknown>) {
    console.error('[ERROR]', msg, meta ?? {});
  }
}
