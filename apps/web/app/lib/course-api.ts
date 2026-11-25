import {
  courseExerciseSubmissionHistoryResponseSchema,
  courseExerciseSubmissionSchema,
  courseGenerationAcceptedResponseSchema,
  courseQuestionHistoryResponseSchema,
  courseQuestionSchema,
  startTaskResponseSchema,
  taskDetailResponseSchema,
  taskSummaryResponseSchema,
  type AskCourseQuestionInput,
  type CourseExerciseSubmission,
  type CourseExerciseSubmissionHistoryResponse,
  type CourseGenerationAcceptedResponse,
  type CourseQuestion,
  type CourseQuestionHistoryResponse,
  type RequestCourseGenerationInput,
  type StartTaskInput,
  type StartTaskResponse,
  type SubmitCourseExerciseInput,
  type TaskDetailResponse,
  type TaskSummaryResponse,
} from '@knowledgeops/contracts'
import { boundedSignal, jsonRequest, request } from './knowledge-ops-api'

export interface CourseApi {
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetailResponse>
  getTaskSummary(taskId: string, signal?: AbortSignal): Promise<TaskSummaryResponse>
  startTask(taskId: string, input: StartTaskInput): Promise<StartTaskResponse>
  requestCourseGeneration(
    taskId: string,
    input: RequestCourseGenerationInput,
  ): Promise<CourseGenerationAcceptedResponse>
  askCourseQuestion(taskId: string, input: AskCourseQuestionInput): Promise<CourseQuestion>
  getCourseQuestions(taskId: string, signal?: AbortSignal): Promise<CourseQuestionHistoryResponse>
  getActiveCourseQuestion(taskId: string, signal?: AbortSignal): Promise<CourseQuestion | null>
  submitCourseExercise(
    taskId: string,
    input: SubmitCourseExerciseInput,
  ): Promise<CourseExerciseSubmission>
  getCourseExerciseSubmissions(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<CourseExerciseSubmissionHistoryResponse>
  getActiveCourseExerciseSubmission(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<CourseExerciseSubmission | null>
}

export function createCourseApi(baseUrl: string): CourseApi {
  return {
    getTask: (taskId, signal) =>
      request(baseUrl, `/tasks/${encodeURIComponent(taskId)}`, taskDetailResponseSchema, {
        signal,
      }),
    getTaskSummary: (taskId, signal) =>
      request(baseUrl, `/tasks/${encodeURIComponent(taskId)}/summary`, taskSummaryResponseSchema, {
        signal,
      }),
    startTask: (taskId, input) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/start`,
        startTaskResponseSchema,
        jsonRequest('POST', input),
      ),
    requestCourseGeneration: (taskId, input) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/course-generation-runs`,
        courseGenerationAcceptedResponseSchema,
        jsonRequest('POST', input),
      ),
    askCourseQuestion: (taskId, input) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/course-questions`,
        courseQuestionSchema,
        jsonRequest('POST', input),
      ),
    getCourseQuestions: (taskId, signal) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/course-questions`,
        courseQuestionHistoryResponseSchema,
        { signal: boundedSignal(signal) },
      ),
    getActiveCourseQuestion: (taskId, signal) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/course-questions/active`,
        courseQuestionSchema.nullable(),
        { signal: boundedSignal(signal) },
      ),
    submitCourseExercise: (taskId, input) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/exercise-submissions`,
        courseExerciseSubmissionSchema,
        jsonRequest('POST', input),
      ),
    getCourseExerciseSubmissions: (taskId, signal) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/exercise-submissions`,
        courseExerciseSubmissionHistoryResponseSchema,
        { signal: boundedSignal(signal) },
      ),
    getActiveCourseExerciseSubmission: (taskId, signal) =>
      request(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/exercise-submissions/active`,
        courseExerciseSubmissionSchema.nullable(),
        { signal: boundedSignal(signal) },
      ),
  }
}
