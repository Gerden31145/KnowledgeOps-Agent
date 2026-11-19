import { z } from 'zod'

export const KNOWLEDGE_MASTERY_LEVELS = ['UNKNOWN', 'WEAK', 'DEVELOPING', 'MASTERED'] as const
export const COURSE_KNOWLEDGE_EVIDENCE_KINDS = ['MULTIPLE_CHOICE', 'FOLLOW_UP'] as const

export const knowledgeMasteryLevelSchema = z.enum(KNOWLEDGE_MASTERY_LEVELS)
export const courseKnowledgeEvidenceKindSchema = z.enum(COURSE_KNOWLEDGE_EVIDENCE_KINDS)

export type KnowledgeMasteryLevel = z.infer<typeof knowledgeMasteryLevelSchema>
export type CourseKnowledgeEvidenceKind = z.infer<typeof courseKnowledgeEvidenceKindSchema>
