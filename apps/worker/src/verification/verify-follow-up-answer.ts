import {
  answerVerificationCandidateSchema,
  answerVerificationRequestSchema,
  NoteVerificationModelError,
  type AnswerVerificationOptions,
  type AnswerVerificationPort,
  type AnswerVerificationRequest,
  type NoteVerificationUsage,
} from '@knowledgeops/agent-core'
import type { AnswerVerificationResult } from '@knowledgeops/contracts'
import { readNoteCitation, type ParsedNoteEvidence } from './parse-note-evidence.js'

export class AnswerVerificationError extends Error {
  override readonly name = 'AnswerVerificationError'
  constructor(
    readonly code: 'INVALID_ANSWER_CONTEXT' | 'INVALID_ANSWER_OUTPUT' | 'INVALID_ANSWER_CITATION',
    readonly usage: NoteVerificationUsage | null = null,
  ) {
    super(code)
  }
}

type LineCitation = { startLine: number; endLine: number; excerpt: string }
function checkCitation(lines: readonly string[], citation: LineCitation) {
  if (
    citation.endLine < citation.startLine ||
    citation.endLine > lines.length ||
    !citation.excerpt.trim() ||
    lines.slice(citation.startLine - 1, citation.endLine).join('\n') !== citation.excerpt
  )
    throw new AnswerVerificationError('INVALID_ANSWER_CITATION')
}

// 单次验收入口：材料须由调用方沿 AnswerSubmission → 追问 → 原笔记读取。
// 持久化执行层负责运行资格、预算登记/结算和数据库落库。
export async function verifyFollowUpAnswer(
  port: AnswerVerificationPort,
  input: Omit<AnswerVerificationRequest, 'note'> & { note: ParsedNoteEvidence },
  options: AnswerVerificationOptions,
): Promise<{ result: AnswerVerificationResult; usage: NoteVerificationUsage | null }> {
  if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
  // 防止等待模型期间，外层修改引用对象将结果挂到另一份回答。
  const frozen = structuredClone(input)
  const parsed = answerVerificationRequestSchema.safeParse({
    ...frozen,
    note: { ...frozen.note.source, lines: frozen.note.lines },
  })
  if (!parsed.success) throw new NoteVerificationModelError('MODEL_INPUT_INVALID')
  const request = parsed.data
  const { question, answer, note } = request
  if (
    question.source.taskId !== request.task.id ||
    answer.questionId !== question.id ||
    Object.entries(frozen.note.source).some(
      ([key, value]) => question.source[key as keyof typeof frozen.note.source] !== value,
    )
  )
    throw new AnswerVerificationError('INVALID_ANSWER_CONTEXT')
  // 原题的引用也必须属于这份笔记，不能只检查新模型返回的引用。
  for (const citation of question.citations) {
    if (citation.endLine > note.lines.length)
      throw new AnswerVerificationError('INVALID_ANSWER_CONTEXT')
    const actual = readNoteCitation(frozen.note, citation.startLine, citation.endLine)
    if (
      !actual.excerpt.trim() ||
      Object.entries(actual).some(([key, value]) => citation[key as keyof typeof actual] !== value)
    )
      throw new AnswerVerificationError('INVALID_ANSWER_CONTEXT')
  }

  const response = await port.verify(structuredClone(request), options)
  if (options.signal.aborted)
    throw new NoteVerificationModelError('MODEL_ABORTED', { usage: response.usage })
  try {
    return {
      result: validateAnswerVerification(request, response.candidate),
      usage: response.usage,
    }
  } catch (error) {
    // 无效候选也可能已消耗 Token，保留用量给后续外层账本结算。
    if (error instanceof AnswerVerificationError)
      throw new AnswerVerificationError(error.code, response.usage)
    throw error
  }
}

// 单次调用和 Finalizer 复用同一份校验，落库恢复也不能跳过来源核对。
export function validateAnswerVerification(
  request: AnswerVerificationRequest,
  value: unknown,
): AnswerVerificationResult {
  const candidate = answerVerificationCandidateSchema.safeParse(value)
  if (!candidate.success) throw new AnswerVerificationError('INVALID_ANSWER_OUTPUT')
  const result = candidate.data
  if (
    result.outcome !== 'INSUFFICIENT_EVIDENCE' &&
    (result.citations.length === 0 || result.answerCitations.length === 0)
  )
    throw new AnswerVerificationError('INVALID_ANSWER_CITATION')
  const { lines, ...source } = request.note
  const citations = result.citations.map((citation) => {
    checkCitation(lines, citation)
    return { ...source, ...citation }
  })
  const answerLines = request.answer.content.split(/\r\n|\n|\r/)
  const answerCitations = result.answerCitations.map((citation) => {
    checkCitation(answerLines, citation)
    return { ...citation, answerSubmissionId: request.answer.id }
  })
  return {
    ...result,
    criterionId: request.question.criterionId,
    questionId: request.question.id,
    answerSubmissionId: request.answer.id,
    citations,
    answerCitations,
  }
}
