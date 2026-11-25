export const courseQueryKeys = {
  courseQuestions: (taskId: string) =>
    ['knowledgeops', 'tasks', taskId, 'course-questions'] as const,
  courseQuestionActive: (taskId: string) =>
    ['knowledgeops', 'tasks', taskId, 'course-questions', 'active'] as const,
  courseExercises: (taskId: string) =>
    ['knowledgeops', 'tasks', taskId, 'course-exercises'] as const,
  courseExerciseActive: (taskId: string) =>
    ['knowledgeops', 'tasks', taskId, 'course-exercises', 'active'] as const,
}
