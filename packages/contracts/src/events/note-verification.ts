import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'

export const NOTE_VERIFICATION_WORKFLOW_VERSION = 'note-v1'
export const NOTE_VERIFICATION_OUTBOX_SCHEMA_VERSION = 1
export const NOTE_VERIFICATION_QUEUE_NAME = 'note-verification'
export const NOTE_VERIFICATION_JOB_NAME = 'verify-note'

// 只传持久化记录的 ID，不把私有正文或 GitHub Token 放进队列。
export const noteVerificationRequestedEventPayloadSchema = z
  .object({
    runId: entityIdSchema,
    submissionId: entityIdSchema,
  })
  .strict()

export type NoteVerificationRequestedPayload = z.infer<
  typeof noteVerificationRequestedEventPayloadSchema
>
export function buildNoteVerificationJobId(runId: string): string {
  return `note-verification-${entityIdSchema.parse(runId)}`
}
