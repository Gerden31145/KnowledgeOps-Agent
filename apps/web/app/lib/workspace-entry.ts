import { z } from 'zod'

const returnKey = 'knowledgeops:login-return'
export const goalDraftKey = 'knowledgeops:goal-draft'
export const goalDraftSchema = z
  .object({
    ownerId: z.string().nullable(),
    savedAt: z.number(),
    form: z
      .object({
        title: z.string().max(160),
        currentLevel: z.string().max(500),
        deadline: z.string().max(10),
        weeklyMinutes: z.number(),
        modelId: z.string().max(100),
      })
      .strict(),
  })
  .strict()

export function safeWorkspaceReturn(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value.includes('\\') ||
    [...value].some((char) => char.charCodeAt(0) <= 32)
  )
    return '/app/plan'
  try {
    const url = new URL(value, 'https://workspace.invalid')
    if (!value.startsWith('/app/') || url.origin !== 'https://workspace.invalid') return '/app/plan'
    if (!/^\/app\/(?:plan|today|repository|tasks\/[a-f0-9-]+)$/.test(url.pathname))
      return '/app/plan'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/app/plan'
  }
}

export function saveLoginReturn(storage: Storage, target: unknown) {
  storage.setItem(
    returnKey,
    JSON.stringify({ path: safeWorkspaceReturn(target), savedAt: Date.now() }),
  )
}

export function hasSavedLoginReturn(storage: Storage): boolean {
  return storage.getItem(returnKey) !== null
}

export function takeLoginReturn(storage: Storage): string | null {
  const raw = storage.getItem(returnKey)
  storage.removeItem(returnKey)
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (
      typeof data.savedAt !== 'number' ||
      Date.now() - data.savedAt > 30 * 60_000 ||
      data.savedAt > Date.now()
    )
      return null
    return safeWorkspaceReturn(data.path)
  } catch {
    return null
  }
}
