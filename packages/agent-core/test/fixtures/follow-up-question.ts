import {
  FOLLOW_UP_OUTPUT_SCHEMA_VERSION,
  FOLLOW_UP_PROMPT_VERSION,
  type FollowUpGenerationRequest,
  type FollowUpQuestionCandidate,
} from '../../src/note-verification/follow-up-question.js'
import { noteVerificationRequest } from './note-verification.js'

export const followUpGenerationRequest: FollowUpGenerationRequest = {
  runId: noteVerificationRequest.runId,
  model: {
    ...noteVerificationRequest.model,
    promptVersion: FOLLOW_UP_PROMPT_VERSION,
    outputSchemaVersion: FOLLOW_UP_OUTPUT_SCHEMA_VERSION,
  },
  task: noteVerificationRequest.task,
  note: noteVerificationRequest.note,
  criterion: {
    id: '55555555-5555-4555-8555-555555555555',
    type: 'FOLLOW_UP_ANSWER',
    description: '能解释微任务继续加入微任务时的执行顺序。',
  },
}

export const followUpCandidate: FollowUpQuestionCandidate = {
  question: '如果一个微任务又加入一个微任务，它与已排队的定时器谁先执行？请解释原因。',
  rubric: ['解释微任务队列会处理到清空。', '说明新加入的微任务仍先于后续定时器任务。'],
  citations: [{ startLine: 3, endLine: 3, excerpt: followUpGenerationRequest.note.lines[2]! }],
}
