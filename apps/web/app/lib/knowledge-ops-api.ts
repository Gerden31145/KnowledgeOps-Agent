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
  sessionResponseSchema,
  type SessionResponse,
  repositoryBindingResponseSchema,
  githubInstallationsResponseSchema,
  repositoryOptionsResponseSchema,
  type RepositoryBindingResponse,
  type GitHubInstallationsResponse,
  type RepositoryOptionsResponse,
  type BindRepositoryInput,
  type UnbindRepositoryInput,
  repositoryEvidenceResponseSchema,
  type RepositoryEvidenceResponse,
  retryRepositoryEvidenceResponseSchema,
  type RetryRepositoryEvidenceInput,
  type RetryRepositoryEvidenceResponse,
} from '@knowledgeops/contracts'
import { z, type ZodType } from 'zod'

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
  getSession(): Promise<SessionResponse>
  logout(): Promise<null>
  getRepositoryBinding(signal?: AbortSignal): Promise<RepositoryBindingResponse>
  getRepositoryEvidence(
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryEvidenceResponse>
  retryRepositoryEvidence(
    repositoryId: string,
    deliveryId: string,
    input: RetryRepositoryEvidenceInput,
  ): Promise<RetryRepositoryEvidenceResponse>
  resyncRepositoryEvidence(
    repositoryId: string,
    deliveryId: string,
    input: RetryRepositoryEvidenceInput,
  ): Promise<RetryRepositoryEvidenceResponse>
  getGitHubInstallations(signal?: AbortSignal): Promise<GitHubInstallationsResponse>
  getRepositoryOptions(
    installationId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryOptionsResponse>
  bindRepository(input: BindRepositoryInput): Promise<RepositoryBindingResponse>
  unbindRepository(input: UnbindRepositoryInput): Promise<RepositoryBindingResponse>
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
    resyncRepositoryEvidence: (repositoryId, deliveryId, input) =>
      request(
        baseUrl,
        `/repositories/${encodeURIComponent(repositoryId)}/evidence-deliveries/${encodeURIComponent(deliveryId)}/resync`,
        retryRepositoryEvidenceResponseSchema,
        { ...jsonRequest('POST', input), signal: repositorySignal() },
      ),
    retryRepositoryEvidence: (repositoryId, deliveryId, input) =>
      request(
        baseUrl,
        `/repositories/${encodeURIComponent(repositoryId)}/evidence-deliveries/${encodeURIComponent(deliveryId)}/retry`,
        retryRepositoryEvidenceResponseSchema,
        { ...jsonRequest('POST', input), signal: repositorySignal() },
      ),
    getRepositoryEvidence: (repositoryId, signal) =>
      request(
        baseUrl,
        `/repositories/${encodeURIComponent(repositoryId)}/evidence-deliveries`,
        repositoryEvidenceResponseSchema,
        { signal: repositorySignal(signal) },
      ),
    getRepositoryBinding: (signal) =>
      request(baseUrl, '/repositories/binding', repositoryBindingResponseSchema, {
        signal: repositorySignal(signal),
      }),
    getGitHubInstallations: (signal) =>
      request(baseUrl, '/repositories/installations', githubInstallationsResponseSchema, {
        signal: repositorySignal(signal),
      }),
    getRepositoryOptions: (installationId, signal) =>
      request(
        baseUrl,
        `/repositories/installations/${encodeURIComponent(installationId)}`,
        repositoryOptionsResponseSchema,
        { signal: repositorySignal(signal) },
      ),
    bindRepository: (input) =>
      request(baseUrl, '/repositories/bind', repositoryBindingResponseSchema, {
        ...jsonRequest('POST', input),
        signal: repositorySignal(),
      }),
    unbindRepository: (input) =>
      request(baseUrl, '/repositories/unbind', repositoryBindingResponseSchema, {
        ...jsonRequest('POST', input),
        signal: repositorySignal(),
      }),
    getSession: () =>
      request(baseUrl, '/auth/session', sessionResponseSchema, {
        signal: AbortSignal.timeout(10_000),
      }),
    logout: () =>
      request(baseUrl, '/auth/logout', z.null(), {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      }),
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

function repositorySignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
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
  const response = await fetch(apiUrl(baseUrl, path), { ...init, credentials: 'include' })
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

export function apiUrl(baseUrl: string, path: string): URL {
  // 保留反向代理的 /api 前缀；业务路径均由客户端代码定义，不接收任意外部 URL。
  return new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
}
