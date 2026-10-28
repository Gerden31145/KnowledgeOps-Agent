import {
  followUpGenerationRequestSchema,
  NoteVerificationModelError,
  type FollowUpGenerationOptions,
  type FollowUpGenerationPort,
  type FollowUpGenerationRequest,
} from '@knowledgeops/agent-core'
import {
  FollowUpQuestionError,
  followUpQuestionSourceSchema,
  validateFollowUpQuestion,
} from './validate-follow-up-question.js'

// 单次调用入口：调用方须先确认笔记通过/当前资格，并从同一 Run 预算登记本次尝试。
// executeNoteVerification 负责调度本入口并结算用量；本函数不自行重试或创建新预算。
export async function generateFollowUpQuestion(
  port: FollowUpGenerationPort,
  input: Omit<Parameters<typeof validateFollowUpQuestion>[0], 'candidate' | 'criterion'> & {
    model: FollowUpGenerationRequest['model']
    task: FollowUpGenerationRequest['task']
    criterion: FollowUpGenerationRequest['criterion']
  },
  options: FollowUpGenerationOptions,
) {
  if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
  // 等待模型期间，调用方修改输入对象也不能把返回的题目改挂到另一份笔记。
  const frozen = structuredClone(input)
  const source = followUpQuestionSourceSchema.safeParse(frozen.source)
  if (!source.success || source.data.taskId !== frozen.task.id) {
    throw new FollowUpQuestionError('INVALID_FOLLOW_UP_CONTEXT')
  }
  const request = followUpGenerationRequestSchema.safeParse({
    runId: source.data.noteRunId,
    model: frozen.model,
    task: frozen.task,
    criterion: frozen.criterion,
    note: { ...frozen.note.source, lines: frozen.note.lines },
  })
  if (!request.success) throw new NoteVerificationModelError('MODEL_INPUT_INVALID')
  const response = await port.generate(request.data, options)
  if (options.signal.aborted)
    throw new NoteVerificationModelError('MODEL_ABORTED', { usage: response.usage })
  try {
    const question = validateFollowUpQuestion({ ...frozen, candidate: response.candidate })
    return { question, usage: response.usage }
  } catch (error) {
    // 生成了伪造引文也可能已经花费 Token，失败同样要把用量交回外层账本。
    if (error instanceof FollowUpQuestionError) {
      throw new FollowUpQuestionError(error.code, response.usage)
    }
    throw error
  }
}
