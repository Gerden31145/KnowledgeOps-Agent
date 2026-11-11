import type {
  NoteVerificationRunResponse,
  NoteRunEvidenceResponse,
  TaskDetailResponse,
} from '@knowledgeops/contracts'

export const taskId = '2359b0ab-c51e-40df-ac45-7e52e79c8380'
export const runId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
export const otherRunId = '69057518-5456-4e20-a956-1c2c021452f3'
export const criterionId = 'fedfb2e2-8f0e-4830-8240-f198cecabd95'

export function taskDetail(overrides: Partial<TaskDetailResponse> = {}): TaskDetailResponse {
  return {
    id: taskId,
    title: '理解 CSS transition',
    description: '说明 duration 和 delay 的区别。',
    position: 0,
    type: 'MARKDOWN_NOTE',
    estimatedMinutes: 30,
    suggestedSteps: ['阅读并解释示例。'],
    targetPath: 'notes/transition.md',
    state: 'IN_PROGRESS',
    version: 2,
    prerequisiteTaskIds: [],
    course: null,
    criteria: [],
    stage: {
      id: criterionId,
      title: 'CSS 基础',
      position: 0,
      plan: { id: criterionId, status: 'ACTIVE' },
    },
    runs: [],
    ...overrides,
  }
}

export function noteEvidence(
  overrides: Partial<NoteRunEvidenceResponse> = {},
): NoteRunEvidenceResponse {
  return {
    taskId,
    runId,
    submissionId: taskId,
    repositoryId: criterionId,
    path: 'notes/transition.md',
    beforeCommitSha: 'a'.repeat(40),
    afterCommitSha: 'b'.repeat(40),
    sourceCommitSha: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    content: '# CSS Transition\r\n\r\nduration 表示持续时间。\r\n',
    lineCount: 3,
    mode: 'DIFF',
    change: 'modified',
    previousPath: null,
    diff: '@@ -1 +1,3 @@\n # CSS Transition\n+\n+duration 表示持续时间。',
    ...overrides,
  }
}

export function noteRun(
  overrides: Partial<NoteVerificationRunResponse> = {},
): NoteVerificationRunResponse {
  return {
    taskId,
    runId,
    submissionId: taskId,
    status: 'SUCCEEDED',
    retryOfRunId: null,
    retryRunId: null,
    version: 2,
    queuedAt: '2026-10-29T00:00:00.000Z',
    startedAt: '2026-10-29T00:00:01.000Z',
    finishedAt: '2026-10-29T00:00:02.000Z',
    errorCode: null,
    followUpQuestion: null,
    report: {
      id: runId,
      createdAt: '2026-10-29T00:00:02.000Z',
      body: {
        results: [
          {
            criterionId,
            outcome: 'FAILED',
            rationale: '笔记将持续时间与延迟时间颠倒。',
            suggestions: ['补充两个时间各自的作用。'],
            citations: [],
            confidence: 0.9,
          },
        ],
        exemptions: [],
        pendingCriterionIds: [],
        followUp: null,
        accounting: {
          knownTotalTokens: 100,
          knownCostMicrounits: 100,
          currency: 'CNY',
          usageComplete: true,
          warnings: [],
        },
      },
    },
    ...overrides,
  }
}
