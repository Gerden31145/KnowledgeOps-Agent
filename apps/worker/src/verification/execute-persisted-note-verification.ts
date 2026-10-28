import { createHash } from 'node:crypto'
import type {
  NoteVerificationOptions,
  NoteVerificationPort,
  FollowUpGenerationPort,
} from '@knowledgeops/agent-core'
import {
  executeNoteVerification,
  type NoteVerificationBudget,
  type NoteVerificationExecution,
  type NoteVerificationInput,
} from './execute-note-verification.js'
import {
  NoteVerificationExecutionRepository,
  type NoteExecutionClaimResult,
} from './note-verification-execution.repository.js'

export type PersistedNoteVerificationResult =
  | { status: 'EXECUTED' | 'REPLAYED'; result: NoteVerificationExecution }
  | Extract<NoteExecutionClaimResult, { status: 'SKIPPED' }>

// 内部用例：调用方先确认 Run/绑定/Task 资格；此处只避免重复模型执行，不直接消费队列。
export async function executePersistedNoteVerification(
  repository: NoteVerificationExecutionRepository,
  port: NoteVerificationPort,
  input: NoteVerificationInput,
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
  followUpPort?: FollowUpGenerationPort,
): Promise<PersistedNoteVerificationResult> {
  const frozen = structuredClone(input)
  const fingerprint = noteExecutionFingerprint(frozen)
  const claimed = await repository.claim({
    runId: frozen.runId,
    taskId: frozen.task.id,
    fingerprint,
    configuration: {
      model: frozen.model,
      budget: structuredClone(budget),
      maxOutputTokens: options.maxOutputTokens,
    },
  })
  if (claimed.status !== 'CLAIMED') return claimed
  const result = await executeNoteVerification(
    port,
    frozen,
    {
      signal: options.signal,
      maxOutputTokens: claimed.configuration.maxOutputTokens,
    },
    claimed.configuration.budget,
    {
      reserve: (attempt, accounting) => repository.reserve(claimed.claim, attempt, accounting),
      settle: (attempt, accounting) => repository.settle(claimed.claim, attempt, accounting),
    },
    followUpPort,
  )
  await repository.finish(claimed.claim, result)
  return { status: 'EXECUTED', result }
}

export function noteExecutionFingerprint(input: NoteVerificationInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        task: input.task,
        model: input.model,
        criteria: input.criteria,
        note: { ...input.note.source, lines: input.note.lines },
        // 旧 R09 输入不加字段，保持历史指纹；新运行还固定出题配置和资格材料。
        ...(input.followUp ? { followUp: input.followUp } : {}),
      }),
    )
    .digest('hex')
}
