import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'

export interface LangChainChatModelConfiguration {
  apiKey?: string
  baseUrl?: string
  structuredOutputMethod?: 'jsonSchema' | 'jsonMode'
}

export interface LangChainChatModelFactoryInput {
  apiKey: string
  baseUrl?: string
  modelName: string
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'high' | 'max'
}

export type LangChainChatModelFactory = (input: LangChainChatModelFactoryInput) => BaseChatModel

// 两种业务复用连接方式；重试由业务运行统一管理，SDK 不自行追加请求。
export function createOpenAiChatModel(input: LangChainChatModelFactoryInput): BaseChatModel {
  return new ChatOpenAI({
    apiKey: input.apiKey,
    model: input.modelName,
    maxRetries: 0,
    temperature: 0,
    ...(input.reasoningEffort ? { modelKwargs: { reasoning_effort: input.reasoningEffort } } : {}),
    ...(input.maxOutputTokens === undefined ? {} : { maxTokens: input.maxOutputTokens }),
    ...(input.baseUrl ? { configuration: { baseURL: input.baseUrl } } : {}),
  })
}
