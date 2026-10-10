import { createHmac, timingSafeEqual } from 'node:crypto'

export interface GitHubSignatureInput {
  rawBody: Buffer
  signature: string | undefined
  secret: string
}

/** R05 唯一小手写入口。只验证签名，不访问数据库、队列或用户会话。 */
export function verifyGitHubWebhookSignature(input: GitHubSignatureInput): boolean {
  // 题面见 docs/local-development.md 的「R05 HMAC 小手写」。
  // 不能用解析后重新序列化的 JSON 替代 rawBody；输入非法或签名不匹配时返回 false。
  if (!input.signature || !input.secret) return false
  const HMAC = createHmac('sha256', input.secret)

  HMAC.update(input.rawBody)

  const result = HMAC.digest()
  if (!input.signature.startsWith('sha256=') || input.signature.length !== 71) return false
  const signatureString = input.signature.slice(7)
  // 先检查原始字符；Buffer 的 hex 解码不能替代格式校验。
  if (!/^[0-9a-fA-F]{64}$/.test(signatureString)) return false
  const bytes = Buffer.from(signatureString, 'hex')

  if (result.length !== bytes.length) return false

  return timingSafeEqual(result, bytes)
}
