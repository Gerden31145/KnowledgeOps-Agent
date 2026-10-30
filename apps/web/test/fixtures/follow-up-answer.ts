import type {
  FollowUpAnswerAcceptedResponse,
  FollowUpAnswerResponse,
} from '@knowledgeops/contracts'
import { taskId, runId as noteRunId, criterionId, noteEvidence } from './note-verification'

export const userId = 'ed446130-08a6-40ec-9442-a7e143d385dc'
export const questionId = 'bedfb2e2-8f0e-4830-8240-f198cecabd95'
export const answerId = 'd37ffd9b-38af-47d4-acad-11563c36955a'
export const answerRunId = '7f55961d-2e1f-4984-9e62-d0d91ebbfc94'
export const receipt = (
  overrides: Partial<FollowUpAnswerAcceptedResponse> = {},
): FollowUpAnswerAcceptedResponse => ({
  status: 'ACCEPTED',
  answerSubmissionId: answerId,
  runId: answerRunId,
  taskId,
  taskVersion: 6,
  ...overrides,
})
export function answerResponse(
  overrides: Partial<FollowUpAnswerResponse> = {},
): FollowUpAnswerResponse {
  const evidence = noteEvidence()
  return {
    answerSubmissionId: answerId,
    questionId,
    answer: 'duration 表示持续时间，delay 表示开始前的等待。',
    createdAt: '2026-10-29T00:00:00.000Z',
    run: {
      runId: answerRunId,
      taskId,
      status: 'SUCCEEDED',
      version: 2,
      retryOfRunId: null,
      retryRunId: null,
      errorCode: null,
      queuedAt: '2026-10-29T00:00:00.000Z',
      startedAt: '2026-10-29T00:00:01.000Z',
      finishedAt: '2026-10-29T00:00:02.000Z',
    },
    report: {
      id: answerId,
      createdAt: '2026-10-29T00:00:02.000Z',
      body: {
        source: {
          taskId,
          submissionId: taskId,
          noteRunId,
          reportId: noteRunId,
          repositoryId: evidence.repositoryId,
          commitSha: evidence.sourceCommitSha,
          path: evidence.path,
          contentHash: evidence.contentHash,
        },
        result: {
          criterionId,
          questionId,
          answerSubmissionId: answerId,
          outcome: 'FAILED',
          rationale: '合成结论：需要补充两个时间如何组合。',
          suggestions: ['补充时间顺序。'],
          citations: [],
          answerCitations: [],
          confidence: 0.8,
        },
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
