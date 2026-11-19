import {
  courseExerciseReportSchema,
  exerciseSetBodySchema,
  type CourseKnowledgeEvidenceKind,
  type KnowledgeMasteryLevel,
} from '@knowledgeops/contracts'

export interface CourseKnowledgeEvidenceDraft {
  knowledgePointKey: string
  questionId: string
  kind: CourseKnowledgeEvidenceKind
  score: number
  misconceptionTags: string[]
}

export interface KnowledgeMasterySummary {
  level: KnowledgeMasteryLevel
  score: number
  evidenceCount: number
  misconceptionTags: string[]
}

export function buildCourseKnowledgeEvidence(
  exerciseSet: unknown,
  report: unknown,
): CourseKnowledgeEvidenceDraft[] {
  const exercises = exerciseSetBodySchema.parse(exerciseSet)
  const parsedReport = courseExerciseReportSchema.parse(report)
  const multipleChoice = parsedReport.multipleChoice.map((result) => {
    const question = exercises.multipleChoice.find((item) => item.id === result.questionId)
    if (!question) throw new Error('Exercise report refers to an unknown question')
    return {
      knowledgePointKey: question.knowledgePointId,
      questionId: question.id,
      kind: 'MULTIPLE_CHOICE' as const,
      score: result.correct ? 100 : 0,
      misconceptionTags: result.correct ? [] : ['选择题概念辨析'],
    }
  })
  const followUpScore =
    parsedReport.followUp.outcome === 'PASSED'
      ? 100
      : parsedReport.followUp.outcome === 'INSUFFICIENT_EVIDENCE'
        ? 50
        : 0
  const followUpTag =
    parsedReport.followUp.outcome === 'PASSED'
      ? null
      : parsedReport.followUp.outcome === 'INSUFFICIENT_EVIDENCE'
        ? '开放追问证据不足'
        : '开放追问概念错误'
  return [
    ...multipleChoice,
    ...exercises.followUp.knowledgePointIds.map((knowledgePointKey) => ({
      knowledgePointKey,
      questionId: exercises.followUp.id,
      kind: 'FOLLOW_UP' as const,
      score: followUpScore,
      misconceptionTags: followUpTag ? [followUpTag] : [],
    })),
  ]
}

export function summarizeKnowledgeMastery(
  evidence: readonly Pick<CourseKnowledgeEvidenceDraft, 'score' | 'misconceptionTags'>[],
): KnowledgeMasterySummary {
  if (evidence.length === 0)
    return { level: 'UNKNOWN', score: 0, evidenceCount: 0, misconceptionTags: [] }
  const score = Math.round(
    evidence.reduce((total, item) => total + item.score, 0) / evidence.length,
  )
  return {
    level: score < 50 ? 'WEAK' : score < 80 ? 'DEVELOPING' : 'MASTERED',
    score,
    evidenceCount: evidence.length,
    misconceptionTags: [...new Set(evidence.flatMap((item) => item.misconceptionTags))],
  }
}
