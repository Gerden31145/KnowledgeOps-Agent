import { describe, expect, it } from 'vitest'
import { verifyGitHubWebhookSignature } from '../src/webhooks/github-webhook-signature.exercise.js'

// Published GitHub test vector, not a live credential or reference implementation:
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const secret = "It's a Secret to Everybody"
const rawBody = Buffer.from('Hello, World!')
const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'

describe('R05 small handwriting: verify the received bytes, not delivery uniqueness', () => {
  it('accepts the published valid signature without mutating the body', () => {
    const body = Buffer.from(rawBody)
    expect(verifyGitHubWebhookSignature({ rawBody: body, signature, secret })).toBe(true)
    expect(
      verifyGitHubWebhookSignature({
        rawBody: body,
        signature: `sha256=${signature.slice(7).toUpperCase()}`,
        secret,
      }),
    ).toBe(true)
    expect(body).toEqual(rawBody)
  })

  it('rejects changes to the bytes, including whitespace and non-ASCII content', () => {
    for (const body of ['Hello, World!\n', ' Hello, World!', 'Hello, World?', 'Hello, 世界!']) {
      expect(verifyGitHubWebhookSignature({ rawBody: Buffer.from(body), signature, secret })).toBe(
        false,
      )
    }
  })

  it('rejects a different or empty secret', () => {
    for (const wrong of ['not-the-shared-secret', '']) {
      expect(verifyGitHubWebhookSignature({ rawBody, signature, secret: wrong })).toBe(false)
    }
  })

  it('rejects missing headers, unsupported algorithms, duplicate values and malformed hex without throwing', () => {
    for (const malformed of [
      undefined,
      '',
      signature.replace('sha256=', ''),
      signature.replace('sha256=', 'sha1='),
      `${signature}, ${signature}`,
      `${signature}\n`,
      `${signature}00`,
      signature.slice(0, -1),
      `sha256=${'g'.repeat(64)}`,
      // Same length; hex decoding alone does not validate the character set.
      signature.replace('7', '\u0137'),
      'sha256=',
    ]) {
      expect(verifyGitHubWebhookSignature({ rawBody, signature: malformed, secret })).toBe(false)
    }
  })

  it('rejects a well-formed but incorrect signature', () => {
    expect(
      verifyGitHubWebhookSignature({ rawBody, secret, signature: `sha256=${'0'.repeat(64)}` }),
    ).toBe(false)
  })
})
