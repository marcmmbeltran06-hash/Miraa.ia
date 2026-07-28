export class PipelineError extends Error {
  public readonly code: 'INVALID_INPUT' | 'CRAWLER_FAILURE' | 'EVENT_BUS_FAILURE';
  public readonly cause?: unknown;

  constructor(code: 'INVALID_INPUT' | 'CRAWLER_FAILURE' | 'EVENT_BUS_FAILURE', message: string, cause?: unknown) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
