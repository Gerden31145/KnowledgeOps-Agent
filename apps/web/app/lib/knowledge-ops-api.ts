import {
  apiErrorResponseSchema,
  confirmPlanResponseSchema,
  learningGoalResponseSchema,
  planDetailResponseSchema,
  planGenerationAcceptedResponseSchema,
  planGenerationModelCatalogResponseSchema,
  planGenerationRunStatusResponseSchema,
  startTaskResponseSchema,
  taskDetailResponseSchema,
  todayTasksResponseSchema,
  type ConfirmPlanResponse,
  type LearningGoalInput,
  type LearningGoalResponse,
  type PlanDetailResponse,
  type PlanGenerationAcceptedResponse,
  type PlanGenerationModelCatalogResponse,
  type PlanGenerationRunStatusResponse,
  type StartPlanGenerationInput,
  type StartTaskInput,
  type StartTaskResponse,
  type TaskDetailResponse,
  type TodayTasksResponse,
  errorCodeSchema,
} from '@knowledgeops/contracts'
import type { ZodType } from 'zod'

export class KnowledgeOpsApiError extends Error {
  override readonly name = 'KnowledgeOpsApiError'

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(message)
  }
}

export interface KnowledgeOpsApi {
  listModels(signal?: AbortSignal): Promise<PlanGenerationModelCatalogResponse>
  createLearningGoal(input: LearningGoalInput): Promise<LearningGoalResponse>
  startPlanGeneration(
    goalId: string,
    input: StartPlanGenerationInput,
  ): Promise<PlanGenerationAcceptedResponse>
  getPlanGenerationRun(
    generationRunId: string,
    signal?: AbortSignal,
  ): Promise<PlanGenerationRunStatusResponse>
  getPlan(planId: string, signal?: AbortSignal): Promise<PlanDetailResponse>
  confirmPlan(planId: string): Promise<ConfirmPlanResponse>
  getTodayTasks(signal?: AbortSignal): Promise<TodayTasksResponse>
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetailResponse>
  startTask(taskId: string, input: StartTaskInput): Promise<StartTaskResponse>
}

export function createKnowledgeOpsApi(baseUrl: string): KnowledgeOpsApi {
  return {
    listModels: (signal) =>
      request(baseUrl, '/plan-generation-models', planGenerationModelCatalogResponseSchema, {
        signal,
      }),
    createLearningGoal: (input) =>
      request(baseUrl, '/learning-goals', learningGoalResponseSchema, jsonRequest('POST', input)),
    startPlanGeneration: (goalId, input) =>
      request(
        baseUrl,
        `/learning-goals/${encodeURIComponent(goalId)}/plan-generation-runs`,
        planGenerationAcceptedResponseSchema,
        jsonRequest('POST', input),
      ),
    getPlanGenerationRun: (generationRunId, signal) =>
      request(
        baseUrl,
        `/plan-generation-runs/${encodeURIComponent(generationRunId)}`,
        planGenerationRunStatusResponseSchema,
        { signal },
      ),
    getPlan: (planId, signal) =>
      request(baseUrl, `/plans/${encodeURIComponent(planId)}`, planDetailResponseSchema, {
        signal,
      }),
    confirmPlan: (planId) =>
      request(baseUrl, `/plans/${encodeURIComponent(planId)}/confirm`, confirmPlanResponseSchema, {
        method: 'POST',
      }),
    getTodayTasks: (signal) =>
      request(baseUrl, '/tasks/today', todayTasksResponseSchema, { signal }),
    getTask: (taskId, signal) =>
      request(baseUrl, `/tasks/${encodeURIComponent(taskId)}`, taskDetailResponseSchema, {
        signal,
      }),
    startTask: (taskId, input) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/start`,
        startTaskResponseSchema,
        jsonRequest('POST', input),
      ),
  }
}

function jsonRequest(method: 'POST', body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(new URL(path, ensureTrailingSlash(baseUrl)), init)
  const payload = await readJson(response)

  if (!response.ok) {
    const parsedError = readApiError(payload)
    throw new KnowledgeOpsApiError(
      parsedError?.message ?? `Request failed with ${response.status}`,
      response.status,
      parsedError?.code ?? 'UNEXPECTED_RESPONSE',
      payload,
    )
  }

  return schema.parse(payload)
}

function readApiError(payload: unknown): { code: string; message: string } | null {
  const canonical = apiErrorResponseSchema.safeParse(payload)
  if (canonical.success) return canonical.data.error
  if (!payload || typeof payload !== 'object') return null

  const code = errorCodeSchema.safeParse(Reflect.get(payload, 'code'))
  const message = Reflect.get(payload, 'message')

  return code.success && typeof message === 'string' && message.length > 0
    ? { code: code.data, message }
    : null
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw new KnowledgeOpsApiError(
      'Server returned invalid JSON',
      response.status,
      'UNEXPECTED_RESPONSE',
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
