import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCourseApi } from '../app/lib/course-api.js'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api.js'
import { createPlanApi } from '../app/lib/plan-api.js'
import { createSessionApi } from '../app/lib/session-api.js'

describe('KnowledgeOps API clients', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses browser credentials for session/logout and preserves an API proxy prefix', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          user: {
            id: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
            githubLogin: 'test-user',
            timezone: 'Asia/Shanghai',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createSessionApi('https://knowledgeops.example/api')
    await expect(api.getSession()).resolves.toMatchObject({ user: { githubLogin: 'test-user' } })
    await expect(api.logout()).resolves.toBeNull()
    expect(fetchMock.mock.calls[0]![0]).toEqual(
      new URL('https://knowledgeops.example/api/auth/session'),
    )
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
    expect(fetchMock.mock.calls[1]).toEqual([
      new URL('https://knowledgeops.example/api/auth/logout'),
      { method: 'POST', credentials: 'include', signal: expect.any(AbortSignal) },
    ])
  })

  it('parses server state through the shared runtime contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          generationRunId: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
          goalId: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
          status: 'RUNNING',
          queuedAt: '2026-09-04T08:00:00.000Z',
          version: 1,
          startedAt: '2026-09-04T08:00:01.000Z',
          finishedAt: null,
          error: null,
          plan: null,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createPlanApi('http://127.0.0.1:4000')

    await expect(
      api.getPlanGenerationRun('2359b0ab-c51e-40df-ac45-7e52e79c8380'),
    ).resolves.toMatchObject({ status: 'RUNNING' })
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/plan-generation-runs/2359b0ab-c51e-40df-ac45-7e52e79c8380'),
      { signal: undefined, credentials: 'include' },
    )
  })

  it('rejects a successful HTTP response that violates the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ status: 'RUNNING' }), { status: 200 })),
    )
    const api = createPlanApi('http://127.0.0.1:4000')

    await expect(
      api.getPlanGenerationRun('2359b0ab-c51e-40df-ac45-7e52e79c8380'),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('preserves conflict details needed to recover an already accepted run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'CONFLICT',
            message: 'An active generation run already exists',
            generationRunId: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
          }),
          { status: 409 },
        ),
      ),
    )
    const api = createPlanApi('http://127.0.0.1:4000')

    const error = await api
      .startPlanGeneration('fedfb2e2-8f0e-4830-8240-f198cecabd95', {
        modelId: 'openai-primary',
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(KnowledgeOpsApiError)
    expect(error).toMatchObject({
      status: 409,
      details: { generationRunId: '2359b0ab-c51e-40df-ac45-7e52e79c8380' },
    })
  })

  it('keeps course history bounded and cancellable through the course-only client', async () => {
    const taskId = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ questions: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const api = createCourseApi('https://knowledgeops.example/api')

    await expect(api.getCourseQuestions(taskId, controller.signal)).resolves.toEqual({
      questions: [],
    })
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(`/api/tasks/${taskId}/course-questions`)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    controller.abort()
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
  })
})
