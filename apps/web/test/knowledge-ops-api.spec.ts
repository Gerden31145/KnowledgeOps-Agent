import { createKnowledgeOpsApi, KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('KnowledgeOps API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses server state through the shared runtime contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          generationRunId: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
          goalId: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
          status: 'RUNNING',
          queuedAt: '2026-09-04T08:00:00.000Z',
          startedAt: '2026-09-04T08:00:01.000Z',
          finishedAt: null,
          error: null,
          plan: null,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('http://127.0.0.1:4000')

    await expect(
      api.getPlanGenerationRun('2359b0ab-c51e-40df-ac45-7e52e79c8380'),
    ).resolves.toMatchObject({ status: 'RUNNING' })
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4000/plan-generation-runs/2359b0ab-c51e-40df-ac45-7e52e79c8380'),
      { signal: undefined },
    )
  })

  it('rejects a successful HTTP response that violates the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ status: 'RUNNING' }), { status: 200 })),
    )
    const api = createKnowledgeOpsApi('http://127.0.0.1:4000')

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
    const api = createKnowledgeOpsApi('http://127.0.0.1:4000')

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
})
