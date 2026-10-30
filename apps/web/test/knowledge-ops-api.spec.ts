import { createKnowledgeOpsApi, KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteRun, noteEvidence, runId, taskId } from './fixtures/note-verification'
import { answerResponse, answerId, questionId, receipt } from './fixtures/follow-up-answer'

describe('KnowledgeOps API client', () => {
  it('retries a saved answer without resubmitting content and reads an explicitly selected Run', async () => {
    const result = { ...receipt(), retryOfRunId: runId }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(result, { status: 202 }))
      .mockResolvedValueOnce(Response.json(answerResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    const input = { expectedRunVersion: 1, expectedTaskVersion: 9 }
    expect(await api.retryAnswerVerification(answerId, runId, input)).toEqual(result)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url.pathname).toBe(`/api/answer-submissions/${answerId}/runs/${runId}/retry`)
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(init.body)).toEqual(input)
    await api.getFollowUpAnswer(answerId, undefined, result.runId)
    expect(fetchMock.mock.calls[1]![0].searchParams.get('runId')).toBe(result.runId)
  })
  it('requests a linked retry with observed versions and parses its immutable source identity', async () => {
    const result = {
      status: 'ACCEPTED',
      runId: taskId,
      retryOfRunId: runId,
      taskId,
      taskVersion: 8,
    }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(result, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const input = { expectedRunVersion: 2, expectedTaskVersion: 7 }
    expect(
      await createKnowledgeOpsApi('https://knowledgeops.example/api').retryNoteVerification(
        runId,
        input,
      ),
    ).toEqual(result)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url.pathname).toBe(`/api/agent-runs/${runId}/retry`)
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(init.body)).toEqual(input)
  })
  it('cancels with only the selected Run version and accepts a terminal race response', async () => {
    const receipt = { runId, taskId, status: 'SUCCEEDED', version: 3 }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(receipt, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(
      await createKnowledgeOpsApi('https://knowledgeops.example/api').cancelVerificationRun(runId, {
        expectedRunVersion: 1,
      }),
    ).toEqual(receipt)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url.pathname).toBe(`/api/agent-runs/${runId}/cancel`)
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(init.body)).toEqual({ expectedRunVersion: 1 })
  })
  it('submits a stable answer command and reads its saved result using authenticated bounded requests', async () => {
    const command = { requestId: runId, expectedTaskVersion: 5, answer: '我的答案' }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(receipt(), { status: 202 }))
      .mockResolvedValueOnce(Response.json(answerResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    expect(await api.submitFollowUpAnswer(questionId, command)).toEqual(receipt())
    const request = fetchMock.mock.calls[0]!
    expect(request[0].pathname).toBe(`/api/follow-up-questions/${questionId}/answers`)
    expect(request[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(request[1].body)).toEqual(command)
    const controller = new AbortController()
    expect(await api.getFollowUpAnswer(answerId, controller.signal)).toEqual(answerResponse())
    expect(fetchMock.mock.calls[1]![0].pathname).toBe(`/api/answer-submissions/${answerId}`)
    controller.abort()
    expect(fetchMock.mock.calls[1]![1].signal.aborted).toBe(true)
  })
  it('reads fixed evidence by run with credentials and abort support', async () => {
    const saved = noteEvidence()
    const fetchMock = vi.fn().mockResolvedValue(Response.json(saved))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    expect(
      await createKnowledgeOpsApi('https://knowledgeops.example/api').getNoteRunEvidence(
        runId,
        controller.signal,
      ),
    ).toEqual(saved)
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(`/api/agent-runs/${runId}/evidence`)
    expect(fetchMock.mock.calls[0]![1].credentials).toBe('include')
    controller.abort()
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
  })
  it('reads a note report with credentials, proxy prefix and cancellation without treating failed criteria as failed execution', async () => {
    const saved = noteRun()
    const fetchMock = vi.fn().mockResolvedValue(Response.json(saved))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const result = await createKnowledgeOpsApi(
      'https://knowledgeops.example/api',
    ).getNoteVerificationRun(runId, controller.signal)
    expect(result.status).toBe('SUCCEEDED')
    expect(result.report?.body.results[0]?.outcome).toBe('FAILED')
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(`/api/agent-runs/${runId}`)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
    controller.abort()
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
  })

  it('rejects a malformed report instead of publishing unvalidated results', async () => {
    const saved = noteRun()
    saved.report!.body.results[0]!.outcome = 'UNKNOWN' as never
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)))
    await expect(
      createKnowledgeOpsApi('https://knowledgeops.example/api').getNoteVerificationRun(runId),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it.each([401, 404])('keeps HTTP %i separate from the persisted Run state', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status })))
    await expect(
      createKnowledgeOpsApi('https://knowledgeops.example/api').getNoteVerificationRun(runId),
    ).rejects.toMatchObject({ name: 'KnowledgeOpsApiError', status })
  })
  it('posts explicit snapshot resync without accepting a client-chosen SHA or task', async () => {
    const id = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const accepted = { deliveryId: id, retryEventId: id, status: 'ACCEPTED' }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(accepted, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    expect(await api.resyncRepositoryEvidence(id, id, { expectedAttemptCount: 2 })).toEqual(
      accepted,
    )
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(
      `/api/repositories/${id}/evidence-deliveries/${id}/resync`,
    )
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ expectedAttemptCount: 2 })
  })
  it('posts evidence recovery using the failed snapshot counter and parses only acceptance', async () => {
    const id = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const accepted = { deliveryId: id, retryEventId: id, status: 'ACCEPTED' }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(accepted, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    expect(await api.retryRepositoryEvidence(id, id, { expectedAttemptCount: 3 })).toEqual(accepted)
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(
      `/api/repositories/${id}/evidence-deliveries/${id}/retry`,
    )
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ expectedAttemptCount: 3 })
  })
  it('reads evidence history with credentials, proxy prefix and a cancellable bounded request', async () => {
    const repositoryId = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ repositoryId, deliveries: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    await expect(api.getRepositoryEvidence(repositoryId, controller.signal)).resolves.toEqual({
      repositoryId,
      deliveries: [],
    })
    expect(fetchMock.mock.calls[0]![0].pathname).toBe(
      `/api/repositories/${repositoryId}/evidence-deliveries`,
    )
    const init = fetchMock.mock.calls[0]![1]
    expect(init).toMatchObject({ credentials: 'include', signal: expect.any(AbortSignal) })
    controller.abort()
    expect(init.signal.aborted).toBe(true)
  })

  it('rejects unrecognized evidence states and extra private response fields', async () => {
    const repositoryId = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const item = {
      deliveryId: repositoryId,
      taskId: repositoryId,
      targetPath: 'notes/test.md',
      commitSha: 'a'.repeat(40),
      receivedAt: '2026-10-15T00:00:00Z',
      attemptCount: 1,
      canRetry: true,
      canResync: false,
      lastAttemptAt: null,
      status: 'FAILED',
      message: '取证未完成。',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ repositoryId, deliveries: [{ ...item, status: 'SUCCEEDED' }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ repositoryId, deliveries: [{ ...item, payload: 'private' }] }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    await expect(api.getRepositoryEvidence(repositoryId)).rejects.toMatchObject({
      name: 'ZodError',
    })
    await expect(api.getRepositoryEvidence(repositoryId)).rejects.toMatchObject({
      name: 'ZodError',
    })
  })

  it('accepts an ignored receipt without a task but rejects invented tasks or recovery eligibility', async () => {
    const repositoryId = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
    const item = {
      deliveryId: repositoryId,
      taskId: null,
      targetPath: null,
      commitSha: 'a'.repeat(40),
      receivedAt: '2026-10-18T00:00:00Z',
      attemptCount: 0,
      canRetry: false,
      canResync: false,
      lastAttemptAt: null,
      status: 'IGNORED',
      message: '接收时没有当前任务，未开始取证。',
    }
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ repositoryId, deliveries: [item] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    expect((await api.getRepositoryEvidence(repositoryId)).deliveries).toEqual([item])
    for (const invalid of [
      { canRetry: true },
      { canResync: true },
      { taskId: repositoryId },
      { targetPath: 'notes/guessed.md' },
      { status: 'COLLECTED' },
      { attemptCount: 1 },
      { lastAttemptAt: item.receivedAt },
      { payload: 'private' },
    ]) {
      fetchMock.mockResolvedValueOnce(
        Response.json({ repositoryId, deliveries: [{ ...item, ...invalid }] }),
      )
      await expect(api.getRepositoryEvidence(repositoryId)).rejects.toMatchObject({
        name: 'ZodError',
      })
    }
  })

  it('uses persisted binding contracts, browser credentials, bounded requests and versioned commands', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ version: 2, repository: null }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
    expect(await api.getRepositoryBinding()).toEqual({ version: 2, repository: null })
    const input = { installationId: '10', githubRepositoryId: '20', expectedVersion: 2 }
    await api.bindRepository(input)
    const unbind = { repositoryId: '2359b0ab-c51e-40df-ac45-7e52e79c8380', expectedVersion: 3 }
    await api.unbindRepository(unbind)
    expect(fetchMock.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/api/repositories/binding',
      '/api/repositories/bind',
      '/api/repositories/unbind',
    ])
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(input)
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual(unbind)
    for (const [, init] of fetchMock.mock.calls)
      expect(init).toMatchObject({ credentials: 'include', signal: expect.any(AbortSignal) })
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
    const api = createKnowledgeOpsApi('https://knowledgeops.example/api')
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
    const api = createKnowledgeOpsApi('http://127.0.0.1:4000')

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
