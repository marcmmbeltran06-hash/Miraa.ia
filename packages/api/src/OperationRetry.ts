export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  onRetry?: (details: { label: string; attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function retryOperation<T>(
  label: string,
  action: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      options.onRetry?.({ label, attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
