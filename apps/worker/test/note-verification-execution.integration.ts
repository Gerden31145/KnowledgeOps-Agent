import { randomUUID } from 'node:crypto'
import { createDatabaseClient } from '@knowledgeops/database'
import type { NoteVerificationPort } from '@knowledgeops/agent-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteVerificationCandidate,
  noteVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/note-verification.js'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { executePersistedNoteVerification } from '../src/verification/execute-persisted-note-verification.js'
import {
  type NoteVerificationAccounting,
  type NoteVerificationBudget,
} from '../src/verification/execute-note-verification.js'
import { NoteVerificationExecutionRepository } from '../src/verification/note-verification-execution.repository.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { noteEvidence } from './fixtures/note-evidence.js'

// 真实 PostgreSQL + 合成模型，不访问供应商、不消费现有 Outbox。
describe('R09 persisted model execution', () => {
  const database = createDatabaseClient(readWorkerEnvironment().DATABASE_URL)
  const userId = randomUUID()
  const taskId = randomUUID()
  let runId: string
  const usage = { inputTokens: 120, outputTokens: 80, totalTokens: 200 }
  const valid = () => ({ candidate: structuredClone(noteVerificationCandidate), usage })
  const context = () => ({
    ...noteVerificationRequest,
    runId,
    task: { ...noteVerificationRequest.task, id: taskId },
    note: parseNoteEvidence(noteEvidence(noteVerificationRequest.note.lines.join('\n'))),
  })
  const options = () => ({ signal: new AbortController().signal, maxOutputTokens: 1_024 })
  const budget = (): NoteVerificationBudget => ({
    maxCalls: 2,
    maxTotalTokens: 2_000,
    maxCostMicrounits: 10_000,
    deadlineAt: new Date(Date.now() + 10_000),
    pricing: {
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 1_000_000,
      outputMicrounitsPerMillionTokens: 2_000_000,
    },
  })
  const saved = () => database.noteVerificationExecution.findUniqueOrThrow({ where: { runId } })
  const repository = () => new NoteVerificationExecutionRepository(database)
  const execute = (
    verify: NoteVerificationPort['verify'],
    repo = repository(),
    limits = budget(),
  ) => executePersistedNoteVerification(repo, { verify }, context(), options(), limits)

  beforeAll(async () => {
    await database.user.create({
      data: {
        id: userId,
        goals: {
          create: {
            title: 'R09 fixture',
            currentLevel: 'fixture',
            deadline: new Date('2026-12-01'),
            weeklyMinutes: 120,
            plans: {
              create: {
                status: 'ACTIVE',
                stages: {
                  create: {
                    title: 'fixture',
                    position: 0,
                    tasks: {
                      create: {
                        id: taskId,
                        title: 'fixture',
                        description: 'fixture',
                        position: 0,
                        estimatedMinutes: 30,
                        state: 'IN_PROGRESS',
                        version: 0,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
  })
  beforeEach(async () => {
    runId = randomUUID()
    await database.agentRun.create({
      data: {
        id: runId,
        taskId,
        kind: 'NOTE_VERIFICATION',
        taskStateBeforeRun: 'IN_PROGRESS',
        workflowVersion: 'note-verification-v1',
      },
    })
  })
  afterAll(async () => {
    try {
      await database.agentRun.deleteMany({ where: { taskId } })
      await database.user.deleteMany({ where: { id: userId } })
    } finally {
      await database.$disconnect()
    }
  })

  it('reserves before each provider call, persists failed usage, and replays after rebuilding the repository', async () => {
    let calls = 0
    const verify = vi.fn().mockImplementation(async () => {
      calls++
      const ledger = await saved()
      expect(ledger.pendingAttempt).toBe(calls)
      expect(ledger.attemptCount).toBe(calls)
      expect(ledger.result).toBeNull()
      if (calls === 2)
        expect(ledger.accounting).toMatchObject({
          knownTotalTokens: 200,
          attempts: [{ errorCode: 'INVALID_MODEL_CITATION' }, { kind: 'REPAIR' }],
        })
      const response = valid()
      if (calls === 1) response.candidate.results[0]!.citations[0]!.excerpt = 'not in the note'
      return response
    })
    const first = await execute(verify)
    expect(first).toMatchObject({
      status: 'EXECUTED',
      result: { status: 'SUCCEEDED', accounting: { knownTotalTokens: 400 } },
    })
    expect(await saved()).toMatchObject({
      attemptCount: 2,
      pendingAttempt: null,
      finishedAt: expect.any(Date),
    })
    const noMoreModel = vi.fn()
    const restarted = await execute(noMoreModel, repository(), {
      ...budget(),
      maxTotalTokens: 999_999,
    })
    expect(restarted.status).toBe('REPLAYED')
    if (first.status === 'EXECUTED' && restarted.status === 'REPLAYED')
      expect(restarted.result).toEqual(first.result)
    expect(noMoreModel).not.toHaveBeenCalled()
    expect((await saved()).configuration).toMatchObject({ budget: { maxTotalTokens: 2_000 } })
    expect(await database.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'QUEUED',
      version: 0,
    })
    expect(await database.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      state: 'IN_PROGRESS',
      version: 0,
    })
  })

  it('allows only one execution while another caller is already awaiting the model', async () => {
    let release!: (value: ReturnType<typeof valid>) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const verify = vi.fn().mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const first = execute(verify)
    await entered
    const secondVerify = vi.fn()
    expect(await execute(secondVerify)).toEqual({
      status: 'SKIPPED',
      reason: 'EXECUTION_IN_PROGRESS',
    })
    expect(secondVerify).not.toHaveBeenCalled()
    release(valid())
    expect(await first).toMatchObject({ status: 'EXECUTED', result: { status: 'SUCCEEDED' } })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('does not reissue a call after settlement failed and does not extend its persisted deadline', async () => {
    const repo = repository()
    vi.spyOn(repo, 'settle').mockRejectedValue(new Error('simulated database outage'))
    const verify = vi.fn().mockResolvedValue(valid())
    const limits = budget()
    await expect(execute(verify, repo, limits)).rejects.toThrow('simulated database outage')
    expect(await saved()).toMatchObject({
      attemptCount: 1,
      pendingAttempt: 1,
      result: null,
      deadlineAt: limits.deadlineAt,
    })
    const noMoreModel = vi.fn()
    expect(await execute(noMoreModel)).toMatchObject({
      status: 'SKIPPED',
      reason: 'EXECUTION_IN_PROGRESS',
    })
    const afterDeadline = new NoteVerificationExecutionRepository(
      database,
      () => new Date(limits.deadlineAt.getTime() + 1),
    )
    expect(await execute(noMoreModel, afterDeadline)).toMatchObject({
      status: 'SKIPPED',
      reason: 'RUN_DEADLINE_EXCEEDED',
    })
    expect(noMoreModel).not.toHaveBeenCalled()
    expect((await saved()).deadlineAt).toEqual(limits.deadlineAt)
  })

  it('never calls the provider when reservation failed', async () => {
    const repo = repository()
    vi.spyOn(repo, 'reserve').mockRejectedValue(new Error('reservation unavailable'))
    const verify = vi.fn().mockResolvedValue(valid())
    await expect(execute(verify, repo)).rejects.toThrow('reservation unavailable')
    expect(verify).not.toHaveBeenCalled()
    expect(await saved()).toMatchObject({ attemptCount: 0, pendingAttempt: null, result: null })
    expect(await execute(verify)).toMatchObject({
      status: 'SKIPPED',
      reason: 'EXECUTION_IN_PROGRESS',
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('replays a committed result after the caller lost acknowledgement', async () => {
    const repo = repository()
    const finish = repo.finish.bind(repo)
    vi.spyOn(repo, 'finish').mockImplementation(async (...args) => {
      await finish(...args)
      throw new Error('ack lost')
    })
    const verify = vi.fn().mockResolvedValue(valid())
    await expect(execute(verify, repo)).rejects.toThrow('ack lost')
    expect(await execute(verify)).toMatchObject({
      status: 'REPLAYED',
      result: { status: 'SUCCEEDED' },
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('persists budget warnings with valid results rather than changing them into failures', async () => {
    const verify = vi.fn().mockResolvedValue({ ...valid(), usage: null })
    expect(await execute(verify)).toMatchObject({
      status: 'EXECUTED',
      result: {
        status: 'SUCCEEDED',
        accounting: { usageComplete: false, warnings: ['MODEL_USAGE_UNKNOWN'] },
      },
    })
    expect(await execute(verify)).toMatchObject({
      status: 'REPLAYED',
      result: {
        status: 'SUCCEEDED',
        accounting: {
          usageComplete: false,
          warnings: ['MODEL_USAGE_UNKNOWN'],
          attempts: [{ usage: null }],
        },
      },
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rejects changed evidence instead of reusing the same Run for another request', async () => {
    const verify = vi.fn().mockResolvedValue(valid())
    await execute(verify)
    const changed = context()
    changed.note = parseNoteEvidence(noteEvidence('# Another note'))
    await expect(
      executePersistedNoteVerification(repository(), { verify }, changed, options(), budget()),
    ).rejects.toMatchObject({ code: 'EXECUTION_CONTEXT_CHANGED' })
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each(['CANCELLED', 'CANCEL_REQUESTED'] as const)(
    'does not execute %s runs or create their execution ledger',
    async (status) => {
      await database.agentRun.update({
        where: { id: runId },
        data: { status, finishedAt: status === 'CANCELLED' ? new Date() : null },
      })
      const verify = vi.fn()
      expect(await execute(verify)).toEqual({
        status: 'SKIPPED',
        reason: status === 'CANCEL_REQUESTED' ? 'RUN_CANCEL_REQUESTED' : 'RUN_TERMINAL',
      })
      expect(verify).not.toHaveBeenCalled()
      expect(await database.noteVerificationExecution.count({ where: { runId } })).toBe(0)
    },
  )

  it('rejects completion if the Run was cancelled during the model call', async () => {
    const verify = vi.fn().mockImplementation(async () => {
      await database.agentRun.update({
        where: { id: runId },
        data: { status: 'CANCEL_REQUESTED', version: { increment: 1 } },
      })
      return valid()
    })
    await expect(execute(verify)).rejects.toMatchObject({ code: 'RUN_NOT_EXECUTABLE' })
    expect(await saved()).toMatchObject({ result: null, pendingAttempt: 1 })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rolls back an invalid checkpoint and rejects writes by a different claim token', async () => {
    const repo = repository()
    const claimed = await repo.claim({
      runId,
      taskId,
      fingerprint: 'f'.repeat(64),
      configuration: {
        model: noteVerificationRequest.model,
        budget: budget(),
        maxOutputTokens: 1024,
      },
    })
    if (claimed.status !== 'CLAIMED') throw new Error('fixture must claim')
    const attempt = {
      runId,
      stepId: 'NOTE_SEMANTICS' as const,
      attempt: 1,
      kind: 'INITIAL' as const,
      startedAt: new Date(),
      finishedAt: new Date(),
      usage: null,
      costMicrounits: null,
      errorCode: null,
    }
    const accounting: NoteVerificationAccounting = {
      attempts: [attempt],
      knownTotalTokens: 0,
      knownCostMicrounits: 0,
      usageComplete: true,
      warnings: [],
    }
    await expect(
      repo.reserve({ ...claimed.claim, claimToken: randomUUID() }, attempt, accounting),
    ).rejects.toMatchObject({ code: 'EXECUTION_CHECKPOINT_CONFLICT' })
    await expect(
      repo.reserve(claimed.claim, { ...attempt, attempt: 2 }, accounting),
    ).rejects.toMatchObject({ code: 'EXECUTION_CHECKPOINT_CONFLICT' })
    expect(await saved()).toMatchObject({
      attemptCount: 0,
      pendingAttempt: null,
      accounting: { attempts: [] },
    })
    await repo.reserve(claimed.claim, attempt, accounting)
    expect(await saved()).toMatchObject({ attemptCount: 1, pendingAttempt: 1 })
  })
})
