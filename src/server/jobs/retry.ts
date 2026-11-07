// One initial attempt and at most five retries, finishing well inside one hour.
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 600_000, 1_200_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export function retryDelay(attempts: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
}
