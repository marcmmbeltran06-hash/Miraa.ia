export type BuilderActivity = 'active' | 'slow_or_blocked';

export function classifyBuilderActivity(silentMs: number): BuilderActivity {
  return silentMs > 600_000 ? 'slow_or_blocked' : 'active';
}

/**
 * Total elapsed build time is deliberately absent. Only explicitly configured
 * inactivity can stop a worker.
 */
export function shouldTerminateBuilderForInactivity(configuredStallTimeoutMs: number, silentMs: number): boolean {
  return configuredStallTimeoutMs > 0 && silentMs > configuredStallTimeoutMs;
}
