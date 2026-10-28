import type { NoteVerificationPort, FollowUpGenerationPort } from '@knowledgeops/agent-core'
import type { NoteVerificationRequestedPayload } from '@knowledgeops/contracts'
import { executePersistedNoteVerification } from './execute-persisted-note-verification.js'
import {
  NoteVerificationExecutionRepository,
  NoteVerificationPersistenceError,
} from './note-verification-execution.repository.js'
import {
  NoteVerificationRunRepository,
  type NoteRunResult,
} from './note-verification-run.repository.js'

export class NoteVerificationJobProcessor {
  constructor(
    private readonly runs: NoteVerificationRunRepository,
    private readonly ledger: NoteVerificationExecutionRepository,
    private readonly model: NoteVerificationPort,
    private readonly followUp?: FollowUpGenerationPort,
  ) {}

  async process(
    message: NoteVerificationRequestedPayload,
    signal = new AbortController().signal,
  ): Promise<NoteRunResult> {
    const prepared = await this.runs.prepare(message)
    if (!prepared.ready) return prepared.result
    try {
      await executePersistedNoteVerification(
        this.ledger,
        this.model,
        prepared.input,
        {
          signal,
          maxOutputTokens: prepared.configuration.maxOutputTokens,
        },
        prepared.configuration.budget,
        this.followUp,
      )
    } catch (error) {
      // 取消/终态与模型返回可能交错；复核业务状态。数据库异常仍交给队列重试。
      if (!(error instanceof NoteVerificationPersistenceError)) throw error
      const current = await this.runs.finalize(message)
      if (current.status !== 'PENDING') return current
      throw error
    }
    const result = await this.runs.finalize(message)
    // 另一个消费者正在执行、或曾在调用中崩溃：不能把“账本存在”当成任务已完成。
    if (result.status === 'PENDING') throw new Error('NOTE_EXECUTION_IN_PROGRESS')
    return result
  }
}
