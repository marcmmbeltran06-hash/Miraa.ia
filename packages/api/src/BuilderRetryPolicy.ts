export interface BuilderRetryDecision {
  shouldRetry: boolean;
  nextAttempt: number;
  delayMs: number;
}

export function getBuilderRetryDecision(
  recoverable: boolean,
  completedAttempts: number,
  maximumAttempts: number,
  baseDelayMs: number,
): BuilderRetryDecision {
  const attempts = Math.max(0, Math.floor(completedAttempts));
  const maximum = Math.max(0, Math.floor(maximumAttempts));
  const delay = Math.max(0, Math.floor(baseDelayMs));
  const shouldRetry = recoverable && attempts < maximum;
  return {
    shouldRetry,
    nextAttempt: shouldRetry ? attempts + 1 : attempts,
    delayMs: shouldRetry ? delay * (2 ** attempts) : 0,
  };
}
