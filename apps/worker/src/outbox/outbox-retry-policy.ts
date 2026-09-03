export interface OutboxRetryPolicy {
  baseDelayMs: number
  maxDelayMs: number
}

export function calculateOutboxRetryDelay(
  previousAttemptCount: number,
  policy: OutboxRetryPolicy,
): number {
  const safeAttemptCount = Math.max(0, Math.min(previousAttemptCount, 30))

  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** safeAttemptCount)
}
