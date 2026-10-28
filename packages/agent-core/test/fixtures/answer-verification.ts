import { createHash } from 'node:crypto'
import {
  ANSWER_VERIFICATION_OUTPUT_SCHEMA_VERSION,
  ANSWER_VERIFICATION_PROMPT_VERSION,
  type AnswerVerificationCandidate,
  type AnswerVerificationRequest,
} from '../../src/answer-verification/answer-verification.js'
import { followUpCandidate, followUpGenerationRequest } from './follow-up-question.js'

const note = {
  ...followUpGenerationRequest.note,
  contentHash: createHash('sha256')
    .update(followUpGenerationRequest.note.lines.join('\n'))
    .digest('hex'),
}
const { lines, ...source } = note
export const answerVerificationRequest: AnswerVerificationRequest = {
  runId: '66666666-6666-4666-8666-666666666666',
  model: {
    ...followUpGenerationRequest.model,
    promptVersion: ANSWER_VERIFICATION_PROMPT_VERSION,
    outputSchemaVersion: ANSWER_VERIFICATION_OUTPUT_SCHEMA_VERSION,
  },
  task: followUpGenerationRequest.task,
  note,
  question: {
    id: '77777777-7777-4777-8777-777777777777',
    question: followUpCandidate.question,
    rubric: followUpCandidate.rubric,
    criterionId: followUpGenerationRequest.criterion.id,
    source: {
      ...source,
      taskId: followUpGenerationRequest.task.id,
      noteRunId: followUpGenerationRequest.runId,
      submissionId: '88888888-8888-4888-8888-888888888888',
      reportId: '99999999-9999-4999-8999-999999999999',
    },
    citations: [{ ...source, startLine: 3, endLine: 3, excerpt: lines[2]! }],
  },
  answer: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    questionId: '77777777-7777-4777-8777-777777777777',
    content: '新加入的微任务仍会先执行。\n因为微任务队列需要处理到清空，才能进入后续定时器任务。',
  },
}
export const answerVerificationCandidate: AnswerVerificationCandidate = {
  outcome: 'PASSED',
  rationale: '回答说明了新微任务的执行顺序及清空队列的原因。',
  suggestions: [],
  confidence: 0.9,
  citations: followUpCandidate.citations,
  answerCitations: [
    { startLine: 1, endLine: 2, excerpt: answerVerificationRequest.answer.content },
  ],
}
