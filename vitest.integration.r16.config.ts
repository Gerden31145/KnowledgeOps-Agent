import { defineConfig } from 'vitest/config'

// 复用已经验证过的故障场景，不再复制一份 R16 业务测试。
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/worker/test/outbox-dispatcher.integration.ts',
      'apps/worker/test/plan-generation-run.repository.integration.ts',
      'apps/worker/test/finalize-plan-generation-run.acceptance.ts',
      'apps/api/test/github-webhook.integration.ts',
      'apps/worker/test/finalize-github-push-evidence.integration.ts',
      'apps/worker/test/github-evidence-processing.integration.ts',
      'apps/worker/test/note-verification-execution.integration.ts',
      'apps/worker/test/note-verification-consumer.integration.ts',
      'apps/worker/test/answer-verification-consumer.integration.ts',
      'apps/worker/test/task-assessment-finalization.integration.ts',
      'apps/api/test/repository-authorization.integration.ts',
    ],
    // 各文件会扫描 Outbox/恢复待办；串行避免互相领取其他夹具的任务。
    fileParallelism: false,
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
