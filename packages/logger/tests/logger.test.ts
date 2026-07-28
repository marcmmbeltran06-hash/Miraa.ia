import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, NoopLogger } from '../src/Logger';

describe('ConsoleLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes debug messages when level is debug', () => {
    const logger = new ConsoleLogger({ level: 'debug', includeTimestamp: false });
    logger.debug('debug message', { meta: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('debug message');
  });

  it('does not write debug messages when level is info', () => {
    const logger = new ConsoleLogger({ level: 'info' });
    logger.debug('should not log');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes error messages and includes metadata', () => {
    const logger = new ConsoleLogger({ level: 'debug', includeTimestamp: false });
    logger.error('error happened', { code: 123 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0][0];
    expect(message).toContain('error happened');
    expect(message).toContain('code');
  });
});

describe('NoopLogger', () => {
  it('does not write any output', () => {
    const logger = new NoopLogger();
    const spy = vi.spyOn(console, 'log');

    logger.info('hello');
    logger.error('fail');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
