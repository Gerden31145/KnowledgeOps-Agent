import type { DatabaseClient } from '../../packages/database/dist/index.js'
import type { NoteFixtureIdentity } from '../../apps/worker/test/fixtures/verification.js'

export async function cleanupFixture(database: DatabaseClient, identity: NoteFixtureIdentity) {
  const { taskId, userId, installationId } = identity
  await database.$transaction(async (tx) => {
    const runs = await tx.agentRun.findMany({ where: { taskId }, select: { id: true } })
    await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: runs.map((run) => run.id) } } })
    // 回答引用笔记报告中的追问；先清回答 Run/Submission，再清笔记。
    await tx.agentRun.deleteMany({ where: { taskId, kind: 'ANSWER_VERIFICATION' } })
    await tx.answerSubmission.deleteMany({ where: { question: { report: { run: { taskId } } } } })
    await tx.agentRun.deleteMany({ where: { taskId } })
    await tx.submission.deleteMany({ where: { taskId } })
    await tx.user.deleteMany({ where: { id: userId } })
    await tx.gitHubInstallation.deleteMany({ where: { id: installationId } })
  })
}
