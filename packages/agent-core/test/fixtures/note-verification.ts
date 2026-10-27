import {
  NOTE_VERIFICATION_OUTPUT_SCHEMA_VERSION,
  NOTE_VERIFICATION_PROMPT_VERSION,
  type NoteVerificationCandidate,
  type NoteVerificationRequest,
} from '../../src/note-verification/note-verification.js'

export const noteVerificationRequest: NoteVerificationRequest = {
  runId: '11111111-1111-4111-8111-111111111111',
  model: {
    catalogId: 'openai-primary',
    provider: 'openai',
    modelName: 'glm-5.3',
    promptVersion: NOTE_VERIFICATION_PROMPT_VERSION,
    outputSchemaVersion: NOTE_VERIFICATION_OUTPUT_SCHEMA_VERSION,
  },
  task: {
    id: '22222222-2222-4222-8222-222222222222',
    title: '解释事件循环',
    description: '说明任务和微任务的执行顺序。',
  },
  criteria: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'SEMANTIC_CORRECTNESS',
      description: '正确解释微任务与当前任务的顺序。',
    },
  ],
  note: {
    repositoryId: '44444444-4444-4444-8444-444444444444',
    commitSha: 'b'.repeat(40),
    path: 'notes/event-loop.md',
    contentHash: 'a'.repeat(64),
    lines: ['# 事件循环', '', '当前任务结束后，先清空微任务队列。'],
  },
}

export const noteVerificationCandidate: NoteVerificationCandidate = {
  results: [
    {
      criterionId: noteVerificationRequest.criteria[0]!.id,
      outcome: 'PASSED',
      rationale: '正文说明了当前任务与微任务的顺序。',
      suggestions: [],
      confidence: 0.8,
      citations: [{ startLine: 3, endLine: 3, excerpt: noteVerificationRequest.note.lines[2]! }],
    },
  ],
}
