import {
  toPublicExerciseSet,
  type CourseExerciseSubmission,
  type CourseQuestion,
  type PlanDetailResponse,
  type TaskDetailResponse,
  type TaskSummaryResponse,
} from '../../packages/contracts/dist/index.js'
import { validCourseLearningPackage } from '../../packages/agent-core/test/fixtures/course-generation.js'

export const performanceWebOrigin = 'http://127.0.0.1:4300'
export const performanceApiOrigin = 'http://127.0.0.1:4400'

export const performanceIds = {
  user: '10000000-0000-4000-8000-000000000001',
  goal: '10000000-0000-4000-8000-000000000002',
  plan: '10000000-0000-4000-8000-000000000003',
  stage: '10000000-0000-4000-8000-000000000004',
  task: '10000000-0000-4000-8000-000000000005',
  run: '10000000-0000-4000-8000-000000000006',
  question: '10000000-0000-4000-8000-000000000007',
  submission: '10000000-0000-4000-8000-000000000008',
} as const

const createdAt = '2026-11-22T00:00:00.000Z'
const course = {
  status: 'READY',
  generationRunId: performanceIds.run,
  generationQueuedAt: createdAt,
  error: null,
} as const

const taskSummary: PlanDetailResponse['stages'][number]['tasks'][number] = {
  id: performanceIds.task,
  title: '理解浏览器事件循环',
  description: '通过页面更新情景理解任务、微任务和渲染顺序。',
  position: 0,
  type: 'COURSE',
  estimatedMinutes: 60,
  suggestedSteps: [],
  targetPath: null,
  state: 'IN_PROGRESS',
  version: 1,
  prerequisiteTaskIds: [],
  criteria: [],
  course,
}

const plan: PlanDetailResponse = {
  id: performanceIds.plan,
  version: 1,
  status: 'ACTIVE',
  confirmedAt: createdAt,
  goal: {
    id: performanceIds.goal,
    title: '准备前端实习面试',
    deadline: '2026-12-31',
    weeklyMinutes: 600,
  },
  stages: [
    {
      id: performanceIds.stage,
      title: '浏览器基础',
      position: 0,
      tasks: [taskSummary],
    },
  ],
}

const task: TaskDetailResponse = {
  ...taskSummary,
  course: {
    ...course,
    sections: validCourseLearningPackage.sections,
    exercises: toPublicExerciseSet(validCourseLearningPackage.exercises),
  },
  stage: {
    id: performanceIds.stage,
    title: '浏览器基础',
    position: 0,
    plan: { id: performanceIds.plan, status: 'ACTIVE' },
  },
  runs: [],
}

const taskSync: TaskSummaryResponse = { ...task, course: { ...course } }

const activeQuestion: CourseQuestion = {
  id: performanceIds.question,
  sectionId: 'task-basics',
  selectedText: validCourseLearningPackage.sections[0]!.explanation,
  question: '为什么当前任务完成后才处理后续工作？',
  depth: 'CONTEXTUAL',
  status: 'RUNNING',
  answer: null,
  createdAt,
  completedAt: null,
}

const activeSubmission: CourseExerciseSubmission = {
  id: performanceIds.submission,
  status: 'RUNNING',
  answers: {
    multipleChoiceAnswers: validCourseLearningPackage.exercises.multipleChoice.map((question) => ({
      questionId: question.id,
      optionId: 'a',
    })),
    followUpAnswer: '当前任务完成后清空微任务，再进入后续任务与渲染调度。',
  },
  report: null,
  errorCode: null,
  createdAt,
  completedAt: null,
}

export type PerformanceScenario = 'anonymous' | 'plan' | 'course' | 'activity'

export function syntheticApiResponse(
  scenario: PerformanceScenario,
  method: string,
  path: string,
): { status: number; body: unknown } {
  const respond = (body: unknown, status = 200) => ({ status, body })

  if (method === 'GET' && path === '/auth/session') {
    return scenario === 'anonymous'
      ? respond({ error: { code: 'UNAUTHENTICATED', message: '请先登录。' } }, 401)
      : respond({
          user: {
            id: performanceIds.user,
            githubLogin: 'performance-fixture',
            timezone: 'Asia/Shanghai',
          },
        })
  }
  if (method === 'GET' && path === '/workspace/entry') {
    return scenario === 'anonymous'
      ? respond({ error: { code: 'UNAUTHENTICATED', message: '请先登录。' } }, 401)
      : respond({ planId: performanceIds.plan, runId: null, goal: null, modelId: null })
  }
  if (method === 'GET' && path === '/plan-generation-models') {
    return respond({ models: [{ id: 'performance-fixture', label: '性能合成模型' }] })
  }
  if (method === 'GET' && path === `/plans/${performanceIds.plan}`) return respond(plan)
  if (method === 'GET' && path === `/tasks/${performanceIds.task}/summary`) return respond(taskSync)
  if (method === 'GET' && path === `/tasks/${performanceIds.task}`) return respond(task)
  if (method === 'GET' && path === `/tasks/${performanceIds.task}/course-questions/active`) {
    return respond(scenario === 'activity' ? activeQuestion : null)
  }
  if (method === 'GET' && path === `/tasks/${performanceIds.task}/course-questions`) {
    return respond({ questions: scenario === 'activity' ? [activeQuestion] : [] })
  }
  if (method === 'GET' && path === `/tasks/${performanceIds.task}/exercise-submissions/active`) {
    return respond(scenario === 'activity' ? activeSubmission : null)
  }
  if (method === 'GET' && path === `/tasks/${performanceIds.task}/exercise-submissions`) {
    return respond({ submissions: scenario === 'activity' ? [activeSubmission] : [] })
  }
  return respond(
    { error: { code: 'UNEXPECTED_RESPONSE', message: 'Unexpected fixture request.' } },
    500,
  )
}
