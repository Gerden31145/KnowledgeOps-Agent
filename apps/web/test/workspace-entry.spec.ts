import { describe, expect, it } from 'vitest'
import {
  hasSavedLoginReturn,
  safeWorkspaceReturn,
  saveLoginReturn,
  takeLoginReturn,
} from '../app/lib/workspace-entry'

describe('workspace login return', () => {
  it('preserves a task, selected report and tab without accepting external destinations', () => {
    const path =
      '/app/tasks/11111111-1111-4111-8111-111111111111?runId=run-a&tab=feedback#note-report'
    expect(safeWorkspaceReturn(path)).toBe(path)
    expect(safeWorkspaceReturn('https://example.com')).toBe('/app/plan')
    expect(safeWorkspaceReturn('//example.com')).toBe('/app/plan')
    expect(safeWorkspaceReturn('/login')).toBe('/app/plan')
    expect(safeWorkspaceReturn('/app/../login')).toBe('/app/plan')
  })
  it('consumes the return once, without triggering a submission', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    } as Storage
    expect(hasSavedLoginReturn(storage)).toBe(false)
    saveLoginReturn(storage, '/app/repository')
    expect(hasSavedLoginReturn(storage)).toBe(true)
    expect(takeLoginReturn(storage)).toBe('/app/repository')
    expect(hasSavedLoginReturn(storage)).toBe(false)
    expect(takeLoginReturn(storage)).toBeNull()
    data.set('knowledgeops:login-return', JSON.stringify({ path: '/app/repository', savedAt: 0 }))
    expect(takeLoginReturn(storage)).toBeNull()
  })
})
