import { describe, it, expect } from 'vitest'
import {
  decideRunTerminationRecovery,
  type RunTerminationRecoveryDecision,
  type RunTerminationRecoveryInput,
} from '../src/index.js'

type RecoveryCase = readonly [
  input: RunTerminationRecoveryInput,
  expected: RunTerminationRecoveryDecision,
]

const RECOVERY_CASES = [
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'IN_PROGRESS',
      runState: 'FAILED',
    },
    {
      kind: 'RESTORE',
      targetTaskState: 'IN_PROGRESS',
      expectedTaskVersion: 1,
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_REVISION',
      runState: 'CANCELLED',
    },
    {
      kind: 'RESTORE',
      targetTaskState: 'NEEDS_REVISION',
      expectedTaskVersion: 1,
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
      runState: 'TIMED_OUT',
    },
    {
      kind: 'RESTORE',
      targetTaskState: 'NEEDS_EVIDENCE',
      expectedTaskVersion: 1,
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
      runState: 'SUCCEEDED',
    },
    {
      kind: 'SKIP',
      reason: 'RUN_NOT_RECOVERABLE',
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
      runState: 'RUNNING',
    },
    {
      kind: 'SKIP',
      reason: 'RUN_NOT_RECOVERABLE',
    },
  ],
  [
    {
      currentTaskState: 'NEEDS_REVISION',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
      runState: 'TIMED_OUT',
    },
    {
      kind: 'SKIP',
      reason: 'TASK_NOT_VERIFYING',
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 2,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
      runState: 'FAILED',
    },
    {
      kind: 'SKIP',
      reason: 'TASK_VERSION_MISMATCH',
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 1,
      taskStateBeforeRun: 'PASSED',
      runState: 'FAILED',
    },
    {
      kind: 'SKIP',
      reason: 'PREVIOUS_TASK_STATE_NOT_RESTORABLE',
    },
  ],
  [
    {
      currentTaskState: 'NEEDS_EVIDENCE',
      currentTaskVersion: 1,
      expectedTaskVersion: 2,
      taskStateBeforeRun: 'PASSED',
      runState: 'SUCCEEDED',
    },
    {
      kind: 'SKIP',
      reason: 'RUN_NOT_RECOVERABLE',
    },
  ],
  [
    {
      currentTaskState: 'NEEDS_EVIDENCE',
      currentTaskVersion: 1,
      expectedTaskVersion: 2,
      taskStateBeforeRun: 'PASSED',
      runState: 'FAILED',
    },
    {
      kind: 'SKIP',
      reason: 'TASK_NOT_VERIFYING',
    },
  ],
  [
    {
      currentTaskState: 'VERIFYING',
      currentTaskVersion: 1,
      expectedTaskVersion: 2,
      taskStateBeforeRun: 'PASSED',
      runState: 'FAILED',
    },
    {
      kind: 'SKIP',
      reason: 'TASK_VERSION_MISMATCH',
    },
  ],
] as const satisfies readonly RecoveryCase[]

describe('decideRunTerminationRecovery stage 1 handwrite', () => {
  it.each(RECOVERY_CASES)('验证AgentRun 终止后的 Task 恢复决策', (input, output) => {
    const inputBeforeCall = { ...input }
    expect(decideRunTerminationRecovery(input)).toEqual(output)
    // 输入不可变性测试
    expect(input).toEqual(inputBeforeCall)
  })
})
