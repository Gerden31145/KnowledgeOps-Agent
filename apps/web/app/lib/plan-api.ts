import {
  confirmPlanResponseSchema,
  learningGoalResponseSchema,
  planDetailResponseSchema,
  planGenerationAcceptedResponseSchema,
  planGenerationModelCatalogResponseSchema,
  planGenerationRunStatusResponseSchema,
  todayTasksResponseSchema,
  workspaceEntryResponseSchema,
  type ConfirmPlanResponse,
  type LearningGoalInput,
  type LearningGoalResponse,
  type PlanDetailResponse,
  type PlanGenerationAcceptedResponse,
  type PlanGenerationModelCatalogResponse,
  type PlanGenerationRunStatusResponse,
  type StartPlanGenerationInput,
  type TodayTasksResponse,
  type WorkspaceEntryResponse,
} from '@knowledgeops/contracts'
import { jsonRequest, request } from './knowledge-ops-api'

export interface PlanApi {
  getWorkspaceEntry(signal?: AbortSignal): Promise<WorkspaceEntryResponse>
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
}

export function createPlanApi(baseUrl: string): PlanApi {
  return {
    getWorkspaceEntry: (signal) =>
      request(baseUrl, '/workspace/entry', workspaceEntryResponseSchema, { signal }),
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
  }
}
