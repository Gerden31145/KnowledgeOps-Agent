import {
  NOTE_VERIFICATION_JOB_NAME,
  NOTE_VERIFICATION_QUEUE_NAME,
  buildNoteVerificationJobId,
  noteVerificationRequestedEventPayloadSchema,
  type NoteVerificationRequestedPayload,
} from '@knowledgeops/contracts'
import {
  BullMqVerificationQueue,
  createVerificationBullMqProcessor,
  type VerificationQueueOptions,
} from './bullmq-verification-queue.js'

const definition = {
  errorPrefix: 'NOTE_VERIFICATION' as const,
  queueName: NOTE_VERIFICATION_QUEUE_NAME,
  jobName: NOTE_VERIFICATION_JOB_NAME,
  schema: noteVerificationRequestedEventPayloadSchema,
  jobId: buildNoteVerificationJobId,
  sourceId: (message: NoteVerificationRequestedPayload) => message.submissionId,
}
export function createNoteVerificationBullMqProcessor(
  handler: VerificationQueueOptions<NoteVerificationRequestedPayload>['processor'],
) {
  return createVerificationBullMqProcessor(handler, definition)
}
export class BullMqNoteVerificationQueue extends BullMqVerificationQueue<NoteVerificationRequestedPayload> {
  constructor(options: VerificationQueueOptions<NoteVerificationRequestedPayload>) {
    super(options, definition)
  }
}
