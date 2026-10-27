import { createHash } from 'node:crypto'
import type { NoteVerificationOptions, NoteVerificationPort } from '@knowledgeops/agent-core'
import {
  executeNoteVerification,
  type NoteVerificationBudget,
  type NoteVerificationExecution,
} from './execute-note-verification.js'
import {
  NoteVerificationExecutionRepository,
  type NoteExecutionClaimResult,
} from './note-verification-execution.repository.js'
import type { verifyNoteSemantics } from './verify-note-semantics.js'

export type PersistedNoteVerificationResult =
  | { status: 'EXECUTED' | 'REPLAYED'; result: NoteVerificationExecution }
  | Extract<NoteExecutionClaimResult, { status: 'SKIPPED' }>

// 内部用例：调用方先确认 Run/绑定/Task 资格；此处只避免重复模型执行，不直接消费队列。
export async function executePersistedNoteVerification(
  repository: NoteVerificationExecutionRepository,
  port: NoteVerificationPort,
  input: Parameters<typeof verifyNoteSemantics>[1],
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
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
  )
  await repository.finish(claimed.claim, result)
  return { status: 'EXECUTED', result }
}

export function noteExecutionFingerprint(input: Parameters<typeof verifyNoteSemantics>[1]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        task: input.task,
        model: input.model,
        criteria: input.criteria,
        note: { ...input.note.source, lines: input.note.lines },
      }),
    )
    .digest('hex')
}
