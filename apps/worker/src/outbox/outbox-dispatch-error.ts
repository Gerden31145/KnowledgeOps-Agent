const MAX_PERSISTED_ERROR_LENGTH = 1_000

const credentialedUrlPattern = /\b(rediss?:\/\/)([^\s/@]+(?::[^\s/@]*)?@)/gi

export type OutboxDispatchFailureKind = 'NON_RETRYABLE' | 'RETRYABLE'

export interface ClassifiedOutboxDispatchFailure {
  code: string
  kind: OutboxDispatchFailureKind
  message: string
}

export class NonRetryableOutboxDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'NonRetryableOutboxDispatchError'
  }
}

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(typeof error === 'string' ? error : 'Unknown outbox dispatch failure')
}

export function sanitizeDispatchErrorMessage(message: string): string {
  return message
    .replace(credentialedUrlPattern, '$1[REDACTED]@')
    .slice(0, MAX_PERSISTED_ERROR_LENGTH)
}

export function classifyOutboxDispatchFailure(error: unknown): ClassifiedOutboxDispatchFailure {
  const normalized = toError(error)

  if (normalized instanceof NonRetryableOutboxDispatchError) {
    return {
      code: normalized.code,
      kind: 'NON_RETRYABLE',
      message: sanitizeDispatchErrorMessage(normalized.message),
    }
  }

  return {
    code: 'OUTBOX_TRANSPORT_UNAVAILABLE',
    kind: 'RETRYABLE',
    message: sanitizeDispatchErrorMessage(normalized.message),
  }
}
