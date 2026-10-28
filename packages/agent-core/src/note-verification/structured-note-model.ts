import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type {
  LangChainChatModelConfiguration,
  LangChainChatModelFactory,
} from '../models/chat-model.js'
import type { NoteVerificationOptions, NoteVerificationUsage } from './note-verification.js'

// 笔记判断、追问生成与回答验收复用 SDK 调用、用量读取及安全错误；不在这里重试。
export class NoteVerificationModelError extends Error {
  override readonly name = 'NoteVerificationModelError'
  readonly usage: NoteVerificationUsage | null
  readonly retryable: boolean
  constructor(
    readonly code:
      | 'MODEL_INPUT_INVALID'
      | 'MODEL_LIMIT_EXCEEDED'
      | 'MODEL_CONFIGURATION_ERROR'
      | 'MODEL_OUTPUT_INVALID'
      | 'MODEL_UPSTREAM_ERROR'
      | 'MODEL_ABORTED',
    details: { usage?: NoteVerificationUsage | null; retryable?: boolean } = {},
  ) {
    super(code)
    this.usage = details.usage ?? null
    this.retryable = details.retryable ?? false
  }
}

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((usage) => usage.total_tokens === usage.input_tokens + usage.output_tokens)

export async function invokeStructuredNoteModel<T>(
  configuration: LangChainChatModelConfiguration,
  createChatModel: LangChainChatModelFactory,
  input: {
    modelName: string
    schema: z.ZodType<T>
    name: string
    systemPrompt: string
    payload: object
  },
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
): Promise<{ candidate: T; usage: NoteVerificationUsage | null }> {
  if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
  if (
    !configuration.apiKey ||
    !Number.isInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > 8_192
  ) {
    throw new NoteVerificationModelError('MODEL_CONFIGURATION_ERROR')
  }
  const payload = JSON.stringify(input.payload)
  // 不静默截断笔记；整个 Run 的调用/费用预算由外层持久化执行器管理。
  if (payload.length > 80_000) throw new NoteVerificationModelError('MODEL_LIMIT_EXCEEDED')
  try {
    const model = createChatModel({
      apiKey: configuration.apiKey,
      modelName: input.modelName,
      ...(configuration.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
      maxOutputTokens: options.maxOutputTokens,
    })
    const method = configuration.structuredOutputMethod ?? 'jsonSchema'
    const structured = model.withStructuredOutput(input.schema, {
      name: input.name,
      method,
      includeRaw: true,
      ...(method === 'jsonSchema' ? { strict: true } : {}),
    })
    const prompt =
      method === 'jsonMode'
        ? `${input.systemPrompt}\nReturn JSON matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(input.schema))}`
        : input.systemPrompt
    const response = await structured.invoke(
      [new SystemMessage(prompt), new HumanMessage(payload)],
      { signal: options.signal },
    )
    const raw = z.object({ usage_metadata: usageSchema }).safeParse(response.raw)
    const metadata = raw.success ? raw.data.usage_metadata : null
    const usage = metadata
      ? {
          inputTokens: metadata.input_tokens,
          outputTokens: metadata.output_tokens,
          totalTokens: metadata.total_tokens,
        }
      : null
    if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED', { usage })
    const parsed = input.schema.safeParse(response.parsed)
    if (!parsed.success) throw new NoteVerificationModelError('MODEL_OUTPUT_INVALID', { usage })
    return { candidate: parsed.data, usage }
  } catch (error: unknown) {
    if (error instanceof NoteVerificationModelError) throw error
    if (options.signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
    if (error instanceof z.core.$ZodError || error instanceof SyntaxError) {
      throw new NoteVerificationModelError('MODEL_OUTPUT_INVALID')
    }
    // SDK 错误可能带原文或凭据；对外只给固定代码和可重试标记。
    const status = z.object({ status: z.number().int() }).safeParse(error)
    throw new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', {
      retryable: status.success && [429, 500, 502, 503, 504].includes(status.data.status),
    })
  }
}
