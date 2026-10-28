import type { AnswerVerificationPort } from '@knowledgeops/agent-core'
import type { AnswerVerificationRequestedPayload } from '@knowledgeops/contracts'
import {
  executePersistedAnswerVerification,
  type AnswerExecutionRepository,
} from './execute-persisted-answer-verification.js'
import { NoteVerificationPersistenceError } from './note-verification-execution.repository.js'
import { AnswerVerificationRunRepository } from './answer-verification-run.repository.js'
import type { VerificationRunResult } from './verification-run-lifecycle.js'

export class AnswerVerificationJobProcessor {
  constructor(
    private readonly runs: AnswerVerificationRunRepository,
    private readonly ledger: AnswerExecutionRepository,
    private readonly model: AnswerVerificationPort,
  ) {}

  async process(
    message: AnswerVerificationRequestedPayload,
    signal = new AbortController().signal,
  ): Promise<VerificationRunResult> {
    const prepared = await this.runs.prepare(message)
    if (!prepared.ready) return prepared.result
    try {
      await executePersistedAnswerVerification(
        this.ledger,
        this.model,
        prepared.input,
        {
          signal,
          maxOutputTokens: prepared.configuration.maxOutputTokens,
        },
        prepared.configuration.budget,
      )
    } catch (error) {
      if (!(error instanceof NoteVerificationPersistenceError)) throw error
      // 模型返回与取消/终态可以交错；先复核业务状态。真实数据库故障仍交队列重试。
      const current = await this.runs.finalize(message)
      if (current.status !== 'PENDING') return current
      throw error
    }
    const result = await this.runs.finalize(message)
    // 另一个消费者仍在执行，或调用中崩溃：不能把“账本存在”当作完成。
    if (result.status === 'PENDING') throw new Error('ANSWER_EXECUTION_IN_PROGRESS')
    return result
  }
}
