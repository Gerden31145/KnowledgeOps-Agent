import type { PlanGenerationRunStatusResponse } from '@knowledgeops/contracts'
import { describe, expect, it } from 'vitest'

import {
  getPlanGenerationTerminalFailure,
  PLAN_GENERATION_POLL_INTERVALS_MS,
  resolvePlanGenerationPollingInterval,
} from '../app/composables/use-plan-generation-polling.exercise.js'

const baseRun: PlanGenerationRunStatusResponse = {
  generationRunId: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
  goalId: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
  status: 'QUEUED',
  queuedAt: '2026-09-04T08:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  plan: null,
}

describe('08-11 TanStack Query polling handwrite acceptance', () => {
  it('backs off non-terminal polling and caps the interval', () => {
    expect(resolvePlanGenerationPollingInterval(snapshot('QUEUED', 1))).toBe(
      PLAN_GENERATION_POLL_INTERVALS_MS[0],
    )
    expect(resolvePlanGenerationPollingInterval(snapshot('RUNNING', 2))).toBe(
      PLAN_GENERATION_POLL_INTERVALS_MS[1],
    )
    expect(resolvePlanGenerationPollingInterval(snapshot('RUNNING', 99))).toBe(
      PLAN_GENERATION_POLL_INTERVALS_MS.at(-1),
    )
    expect(resolvePlanGenerationPollingInterval(snapshot('RUNNING', 0))).toBe(
      PLAN_GENERATION_POLL_INTERVALS_MS[0],
    )
  })

  it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const)(
    'stops polling after the %s terminal state',
    (status) => {
      expect(resolvePlanGenerationPollingInterval(snapshot(status, 3))).toBe(false)
    },
  )

  it('maps persisted failed and timed-out terminals without treating transport errors as domain failures', () => {
    expect(
      getPlanGenerationTerminalFailure({
        ...baseRun,
        status: 'FAILED',
        error: { code: 'MODEL_UPSTREAM_ERROR', message: 'Provider unavailable' },
      }),
    ).toEqual({
      status: 'FAILED',
      code: 'MODEL_UPSTREAM_ERROR',
      message: 'Provider unavailable',
    })
    expect(
      getPlanGenerationTerminalFailure({ ...baseRun, status: 'TIMED_OUT', error: null }),
    ).toEqual({
      status: 'TIMED_OUT',
      code: 'RUN_DEADLINE_EXCEEDED',
      message: expect.any(String),
    })
    expect(getPlanGenerationTerminalFailure({ ...baseRun, status: 'FAILED', error: null })).toEqual(
      {
        status: 'FAILED',
        code: 'PLAN_GENERATION_FAILED',
        message: expect.any(String),
      },
    )
    expect(getPlanGenerationTerminalFailure({ ...baseRun, status: 'RUNNING' })).toBeNull()
    expect(getPlanGenerationTerminalFailure(undefined)).toBeNull()
  })
})

function snapshot(status: PlanGenerationRunStatusResponse['status'], dataUpdateCount: number) {
  return {
    state: {
      data: { ...baseRun, status },
      dataUpdateCount,
    },
  }
}
