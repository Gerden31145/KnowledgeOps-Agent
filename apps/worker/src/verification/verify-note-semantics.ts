import {
  NoteVerificationModelError,
  noteSemanticCriterionTypeSchema,
  type NoteVerificationOptions,
  type NoteVerificationPort,
  type NoteVerificationRequest,
} from '@knowledgeops/agent-core'
import type { NoteCriterion } from './check-note-criteria.js'
import type { ParsedNoteEvidence } from './parse-note-evidence.js'
import {
  NoteVerificationCandidateError,
  validateNoteVerification,
} from './validate-note-verification.js'

// 调用方先按 R08 校验固定正文；此用例串起一次模型调用和引用校验，不写数据库。
export async function verifyNoteSemantics(
  port: NoteVerificationPort,
  input: {
    runId: string
    model: NoteVerificationRequest['model']
    task: NoteVerificationRequest['task']
    note: ParsedNoteEvidence
    criteria: readonly (Pick<NoteCriterion, 'id' | 'type'> & { description: string })[]
  },
  options: NoteVerificationOptions,
) {
  if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
  const criteria = input.criteria.flatMap((criterion) => {
    const type = noteSemanticCriterionTypeSchema.safeParse(criterion.type)
    return type.success
      ? [{ id: criterion.id, type: type.data, description: criterion.description }]
      : []
  })
  if (criteria.length === 0) return { results: [], usage: null }
  const response = await port.verify(
    {
      runId: input.runId,
      model: input.model,
      task: input.task,
      criteria,
      note: { ...input.note.source, lines: input.note.lines },
    },
    options,
  )
  if (options.signal.aborted)
    throw new NoteVerificationModelError('MODEL_ABORTED', { usage: response.usage })
  try {
    // 即使替换模型适配器，也不能跳过业务侧的标准/引用核对。
    const results = validateNoteVerification({
      note: input.note,
      criteria: input.criteria,
      candidate: response.candidate,
    })
    return { results, usage: response.usage }
  } catch (error) {
    if (error instanceof NoteVerificationCandidateError) {
      throw new NoteVerificationCandidateError(error.code, response.usage)
    }
    throw error
  }
}
