import type { CourseGenerationOutput } from '@knowledgeops/agent-core'
import type { PlanGenerationRunState } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'

import { json } from './course-generation-run.repository.js'

export interface FinalizeCourseGenerationRunCommand {
  candidate: CourseGenerationOutput
  expectedRunVersion: number
  finishedAt: Date
  generationRunId: string
}

export type FinalizeCourseGenerationRunResult =
  | { status: 'FINALIZED'; courseVersionId: string }
  | { status: 'SKIPPED'; runStatus: PlanGenerationRunState }

export class FinalizeCourseGenerationRun {
  constructor(private readonly database: DatabaseClient) {}

  async execute(
    command: FinalizeCourseGenerationRunCommand,
  ): Promise<FinalizeCourseGenerationRunResult> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM course_generation_runs WHERE id = ${command.generationRunId}::uuid FOR UPDATE`
      const run = await tx.courseGenerationRun.findUnique({
        where: { id: command.generationRunId },
        select: {
          status: true,
          version: true,
          deadlineAt: true,
          courseId: true,
          course: {
            select: {
              versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 },
            },
          },
        },
      })
      if (
        !run ||
        run.status !== 'RUNNING' ||
        run.version !== command.expectedRunVersion ||
        run.deadlineAt <= command.finishedAt
      )
        return { status: 'SKIPPED', runStatus: run?.status ?? 'FAILED' }

      const courseVersion = await tx.courseVersion.create({
        data: {
          courseId: run.courseId,
          generationRunId: command.generationRunId,
          version: (run.course.versions[0]?.version ?? 0) + 1,
          content: json({ sections: command.candidate.sections }),
          exerciseSet: { create: { body: json(command.candidate.exercises) } },
        },
      })
      await tx.courseGenerationRun.update({
        where: { id: command.generationRunId },
        data: {
          status: 'SUCCEEDED',
          version: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          finishedAt: command.finishedAt,
          course: { update: { status: 'READY' } },
        },
      })
      return { status: 'FINALIZED', courseVersionId: courseVersion.id }
    })
  }
}
