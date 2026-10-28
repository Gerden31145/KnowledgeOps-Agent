import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'

export const ANSWER_VERIFICATION_WORKFLOW_VERSION = 'answer-v1'
export const ANSWER_VERIFICATION_OUTBOX_SCHEMA_VERSION = 1
export const ANSWER_VERIFICATION_QUEUE_NAME = 'answer-verification'
export const ANSWER_VERIFICATION_JOB_NAME = 'verify-answer'

// 队列只引用数据库材料；答案正文和评分要点不复制到 Outbox。
export const answerVerificationRequestedEventPayloadSchema = z
  .object({
    runId: entityIdSchema,
    answerSubmissionId: entityIdSchema,
  })
  .strict()
export type AnswerVerificationRequestedPayload = z.infer<
  typeof answerVerificationRequestedEventPayloadSchema
>
export function buildAnswerVerificationJobId(runId: string): string {
  return `answer-verification-${entityIdSchema.parse(runId)}`
}
