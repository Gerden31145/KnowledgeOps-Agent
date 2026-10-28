import {
  ANSWER_VERIFICATION_JOB_NAME,
  ANSWER_VERIFICATION_QUEUE_NAME,
  buildAnswerVerificationJobId,
  answerVerificationRequestedEventPayloadSchema,
  type AnswerVerificationRequestedPayload,
} from '@knowledgeops/contracts'
import {
  BullMqVerificationQueue,
  createVerificationBullMqProcessor,
  type VerificationQueueOptions,
} from './bullmq-verification-queue.js'

const definition = {
  errorPrefix: 'ANSWER_VERIFICATION' as const,
  queueName: ANSWER_VERIFICATION_QUEUE_NAME,
  jobName: ANSWER_VERIFICATION_JOB_NAME,
  schema: answerVerificationRequestedEventPayloadSchema,
  jobId: buildAnswerVerificationJobId,
  sourceId: (message: AnswerVerificationRequestedPayload) => message.answerSubmissionId,
}
export function createAnswerVerificationBullMqProcessor(
  handler: VerificationQueueOptions<AnswerVerificationRequestedPayload>['processor'],
) {
  return createVerificationBullMqProcessor(handler, definition)
}
export class BullMqAnswerVerificationQueue extends BullMqVerificationQueue<AnswerVerificationRequestedPayload> {
  constructor(options: VerificationQueueOptions<AnswerVerificationRequestedPayload>) {
    super(options, definition)
  }
}
