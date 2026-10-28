import { randomUUID, randomInt } from 'node:crypto'
import type { DatabaseClient, Prisma } from '@knowledgeops/database'
import { noteEvidence } from './note-evidence.js'
export type NoteFixtureIdentity = {
  userId: string
  taskId: string
  runId: string
  eventId: string
  installationId: string
}

export async function createNoteVerificationFixture(
  database: DatabaseClient,
  register: (value: NoteFixtureIdentity) => void,
): Promise<{
  userId: string
  taskId: string
  repositoryId: string
  runId: string
  submissionId: string
  eventId: string
  payload: { runId: string; submissionId: string }
  run(): Promise<Prisma.AgentRunGetPayload<{ include: { report: true; modelExecution: true } }>>
  task(): Promise<Prisma.TaskGetPayload<object>>
}> {
  const userId = randomUUID(),
    taskId = randomUUID(),
    repositoryId = randomUUID(),
    submissionId = randomUUID()
  const runId = randomUUID(),
    eventId = randomUUID()
  const installationId = String(randomInt(8_000_000_000_000, 9_000_000_000_000))
  const content = '# 事件循环\n\n当前任务结束后，先清空微任务队列。'
  register({ userId, taskId, runId, eventId, installationId })
  await database.user.create({
    data: {
      id: userId,
      goals: {
        create: {
          title: 'R09 consumer fixture',
          currentLevel: 'fixture',
          weeklyMinutes: 120,
          deadline: new Date('2026-12-01'),
          plans: {
            create: {
              status: 'ACTIVE',
              stages: {
                create: {
                  title: 'fixture',
                  position: 0,
                  tasks: {
                    create: {
                      id: taskId,
                      title: '事件循环',
                      description: '解释微任务顺序',
                      position: 0,
                      estimatedMinutes: 30,
                      state: 'VERIFYING',
                      version: 6,
                      targetPath: 'notes/event-loop.md',
                      criteria: {
                        create: [
                          { type: 'FILE_CHANGED', position: 0, description: '修改文件' },
                          {
                            type: 'SECTION_PRESENT',
                            position: 1,
                            description: '存在章节',
                            config: { heading: '事件循环' },
                          },
                          {
                            type: 'SEMANTIC_CORRECTNESS',
                            position: 2,
                            description: '正确解释顺序',
                          },
                          { type: 'FOLLOW_UP_ANSWER', position: 3, description: '完成追问' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  await database.gitHubInstallation.create({
    data: { id: installationId, accountId: '42', accountLogin: 'fixture', verifiedAt: new Date() },
  })
  await database.repository.create({
    data: {
      id: repositoryId,
      userId,
      installationId,
      githubRepositoryId: installationId,
      fullName: 'fixture/notes',
      branch: 'main',
      defaultBranch: 'main',
      isPrivate: true,
    },
  })
  const fixed = noteEvidence(content)
  const evidence = {
    content: fixed.content,
    contentHash: fixed.contentHash,
    lineCount: fixed.lineCount,
    sourceCommitSha: fixed.sourceCommitSha,
    mode: fixed.mode,
    change: fixed.change,
  }
  await database.submission.create({
    data: {
      id: submissionId,
      repositoryId,
      taskId,
      taskVersion: 5,
      beforeCommitSha: 'a'.repeat(40),
      afterCommitSha: 'b'.repeat(40),
      targetPath: fixed.path,
      workflowVersion: 'note-v1',
      evidence: {
        create: {
          ...evidence,
          diff: '@@ -1 +1,3 @@\n # 事件循环\n+\n+当前任务结束后，先清空微任务队列。',
        },
      },
    },
  })
  await database.agentRun.create({
    data: {
      id: runId,
      submissionId,
      taskId,
      expectedTaskVersion: 6,
      kind: 'NOTE_VERIFICATION',
      taskStateBeforeRun: 'IN_PROGRESS',
      workflowVersion: 'note-v1',
    },
  })
  const payload = { runId, submissionId }
  await database.outboxEvent.create({
    data: {
      id: eventId,
      type: 'NOTE_VERIFICATION_REQUESTED',
      aggregateId: runId,
      deduplicationKey: `note-verification-requested-${runId}`,
      payload,
    },
  })
  return {
    userId,
    taskId,
    repositoryId,
    runId,
    submissionId,
    payload,
    eventId,
    run: () =>
      database.agentRun.findUniqueOrThrow({
        where: { id: runId },
        include: { report: true, modelExecution: true },
      }),
    task: () => database.task.findUniqueOrThrow({ where: { id: taskId } }),
  }
}
