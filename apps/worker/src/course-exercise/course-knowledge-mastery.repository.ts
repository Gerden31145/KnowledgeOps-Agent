import { buildCourseKnowledgeEvidence, summarizeKnowledgeMastery } from '@knowledgeops/agent-core'
import type { CourseExerciseReport, ExerciseSetBody } from '@knowledgeops/contracts'
import type { Prisma } from '@knowledgeops/database'
import { z } from 'zod'

const misconceptionTagsSchema = z.array(z.string().trim().min(1).max(100)).max(3)

export async function recordFirstSubmissionKnowledge(
  tx: Prisma.TransactionClient,
  input: {
    submissionId: string
    exerciseSetId: string
    userId: string
    planId: string
    exerciseSet: ExerciseSetBody
    report: CourseExerciseReport
    completedAt: Date
  },
): Promise<boolean> {
  const previousReport = await tx.courseExerciseSubmission.findFirst({
    where: { exerciseSetId: input.exerciseSetId, userId: input.userId, status: 'SUCCEEDED' },
    select: { id: true },
  })
  if (previousReport) return false

  const drafts = buildCourseKnowledgeEvidence(input.exerciseSet, input.report)
  const knowledgePoints = await tx.knowledgePoint.findMany({
    where: { planId: input.planId, key: { in: drafts.map((draft) => draft.knowledgePointKey) } },
    select: { id: true, key: true },
  })
  const knowledgePointIds = new Map(knowledgePoints.map((point) => [point.key, point.id]))
  const rows = drafts.flatMap((draft) => {
    const knowledgePointId = knowledgePointIds.get(draft.knowledgePointKey)
    return knowledgePointId
      ? [
          {
            submissionId: input.submissionId,
            knowledgePointId,
            questionId: draft.questionId,
            kind: draft.kind,
            score: draft.score,
            misconceptionTags: draft.misconceptionTags,
            createdAt: input.completedAt,
          },
        ]
      : []
  })
  if (rows.length === 0) return false
  await tx.courseKnowledgeEvidence.createMany({ data: rows, skipDuplicates: true })

  for (const knowledgePointId of new Set(rows.map((row) => row.knowledgePointId))) {
    const evidence = await tx.courseKnowledgeEvidence.findMany({
      where: { knowledgePointId, submission: { userId: input.userId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { score: true, misconceptionTags: true },
    })
    const summary = summarizeKnowledgeMastery(
      evidence.map((item) => ({
        score: item.score,
        misconceptionTags: misconceptionTagsSchema.parse(item.misconceptionTags),
      })),
    )
    await tx.knowledgeMastery.upsert({
      where: {
        userId_knowledgePointId: { userId: input.userId, knowledgePointId },
      },
      create: {
        userId: input.userId,
        knowledgePointId,
        level: summary.level,
        score: summary.score,
        evidenceCount: summary.evidenceCount,
        misconceptionTags: summary.misconceptionTags,
      },
      update: {
        level: summary.level,
        score: summary.score,
        evidenceCount: summary.evidenceCount,
        misconceptionTags: summary.misconceptionTags,
      },
    })
  }
  return true
}
