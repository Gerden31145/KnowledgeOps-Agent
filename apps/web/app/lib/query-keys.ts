export const knowledgeOpsQueryKeys = {
  all: ['knowledgeops'] as const,
  modelCatalog: () => ['knowledgeops', 'plan-generation-models'] as const,
  generationRun: (generationRunId: string) =>
    ['knowledgeops', 'plan-generation-runs', generationRunId] as const,
  plan: (planId: string) => ['knowledgeops', 'plans', planId] as const,
  tasks: () => ['knowledgeops', 'tasks'] as const,
  todayTasks: () => ['knowledgeops', 'tasks', 'today'] as const,
  task: (taskId: string) => ['knowledgeops', 'tasks', taskId] as const,
  courseQuestions: (taskId: string) =>
    ['knowledgeops', 'tasks', taskId, 'course-questions'] as const,
  noteVerificationRun: (taskId: string, runId: string) =>
    ['knowledgeops', 'tasks', taskId, 'note-verification-runs', runId] as const,
  noteRunEvidence: (taskId: string, runId: string) =>
    ['knowledgeops', 'tasks', taskId, 'note-verification-runs', runId, 'evidence'] as const,
  followUpAnswer: (taskId: string, questionId: string, answerId: string, runId?: string | null) =>
    [
      'knowledgeops',
      'tasks',
      taskId,
      'follow-up-questions',
      questionId,
      'answers',
      answerId,
      runId ?? 'initial',
    ] as const,
}
