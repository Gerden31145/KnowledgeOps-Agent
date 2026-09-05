export const knowledgeOpsQueryKeys = {
  all: ['knowledgeops'] as const,
  modelCatalog: () => ['knowledgeops', 'plan-generation-models'] as const,
  generationRun: (generationRunId: string) =>
    ['knowledgeops', 'plan-generation-runs', generationRunId] as const,
  plan: (planId: string) => ['knowledgeops', 'plans', planId] as const,
  tasks: () => ['knowledgeops', 'tasks'] as const,
  todayTasks: () => ['knowledgeops', 'tasks', 'today'] as const,
  task: (taskId: string) => ['knowledgeops', 'tasks', taskId] as const,
}
