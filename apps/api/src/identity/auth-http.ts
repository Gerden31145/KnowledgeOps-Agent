import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { SessionResponse } from '@knowledgeops/contracts'

export const OAUTH_TTL_SECONDS = 10 * 60
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const opaqueToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export type AuthUser = SessionResponse['user']
export type AuthRequest = IncomingMessage & { sessionUser?: Promise<AuthUser> }

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  const value = values.length === 1 ? values[0]?.slice(name.length + 1) : undefined
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}

export function tokensMatch(left: string | undefined, right: string | undefined): boolean {
  return (
    !!left &&
    !!right &&
    Buffer.byteLength(left) === Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  )
}

export function authCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
