import {
  followUpQuestionCandidateSchema,
  type NoteVerificationUsage,
} from '@knowledgeops/agent-core'
import { entityIdSchema } from '@knowledgeops/contracts'
import { z } from 'zod'
import type { NoteCriterion } from './check-note-criteria.js'
import { readNoteCitation, type ParsedNoteEvidence } from './parse-note-evidence.js'

export const followUpQuestionSourceSchema = z
  .object({
    taskId: entityIdSchema,
    submissionId: entityIdSchema,
    noteRunId: entityIdSchema,
    reportId: entityIdSchema,
  })
  .strict()

export class FollowUpQuestionError extends Error {
  override readonly name = 'FollowUpQuestionError'

  constructor(
    readonly code:
      'INVALID_FOLLOW_UP_CONTEXT' | 'INVALID_FOLLOW_UP_OUTPUT' | 'INVALID_FOLLOW_UP_CITATION',
    readonly usage: NoteVerificationUsage | null = null,
  ) {
    super(code)
  }
}

// source/criterion 必须由调用方从同一次笔记运行及其报告读取，note 已通过 parseNoteEvidence。
// 此函数只校验候选并绑定来源；当前用户权限、笔记是否通过及旧题是否失效由持久化链路复核。
// 不请求模型、不写数据库，也不会创建回答 Run 或修改 Task。
export function validateFollowUpQuestion(input: {
  source: z.infer<typeof followUpQuestionSourceSchema>
  criterion: Pick<NoteCriterion, 'id' | 'type'>
  note: ParsedNoteEvidence
  candidate: unknown
}) {
  const source = followUpQuestionSourceSchema.safeParse(input.source)
  if (
    !source.success ||
    input.criterion.type !== 'FOLLOW_UP_ANSWER' ||
    !entityIdSchema.safeParse(input.criterion.id).success
  ) {
    throw new FollowUpQuestionError('INVALID_FOLLOW_UP_CONTEXT')
  }
  const candidate = followUpQuestionCandidateSchema.safeParse(input.candidate)
  if (!candidate.success) throw new FollowUpQuestionError('INVALID_FOLLOW_UP_OUTPUT')
  const citations = candidate.data.citations.map((citation) => {
    if (citation.endLine < citation.startLine || citation.endLine > input.note.lines.length) {
      throw new FollowUpQuestionError('INVALID_FOLLOW_UP_CITATION')
    }
    const actual = readNoteCitation(input.note, citation.startLine, citation.endLine)
    if (!actual.excerpt.trim() || actual.excerpt !== citation.excerpt) {
      throw new FollowUpQuestionError('INVALID_FOLLOW_UP_CITATION')
    }
    return actual
  })
  return {
    ...candidate.data,
    criterionId: input.criterion.id,
    source: { ...source.data, ...input.note.source },
    citations,
  }
}

export type FollowUpQuestionDraft = ReturnType<typeof validateFollowUpQuestion>
