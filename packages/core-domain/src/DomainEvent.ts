// DomainEvent.ts
/** Base interface for all domain events */
export interface DomainEvent {
  /** Discriminated event type */
  type: string;
  /** Optional payload with event data */
  payload?: unknown;
  /** Optional metadata (timestamp, correlation id, etc.) */
  metadata?: Record<string, unknown>;
}
