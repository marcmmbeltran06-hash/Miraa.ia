export interface DomainEvent {
  readonly type: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
}
