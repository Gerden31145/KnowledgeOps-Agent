import { createHash, generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseClient } from '@knowledgeops/database'
import { validPlanGenerationOutput } from '../../../../packages/agent-core/test/fixtures/plan-generation.js'
import { BoundCommitEvidenceReader } from '../../src/github/read-bound-commit-evidence.js'

export const pipelinePlan = validPlanGenerationOutput
export const noteContent = '# 事件循环\n\n当前任务结束后，先清空微任务队列。'
export const targetPath = pipelinePlan.stages[0].tasks[0].targetPath
export const beforeSha = 'a'.repeat(40)
export const afterSha = 'b'.repeat(40)
export const repositoryName = 'r16-fixture/learning-notes'

// 保留真实的绑定检查、App JWT、固定 SHA 读取与内容哈希验证。
// 只替换 GitHub 的 HTTP 返回；未列出的请求直接失败，绝不退回真实网络。
export function createGitHubUpstream(database: DatabaseClient, installationId: string) {
  const bytes = Buffer.from(noteContent)
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const calls: string[] = []
  const upstream: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture origin')
    const route = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`
    calls.push(route)
    switch (route) {
      case `GET /app/installations/${installationId}`:
        return Response.json({
          id: Number(installationId),
          account: { id: 42, login: 'r16-fixture' },
          permissions: { contents: 'read' },
          repository_selection: 'selected',
          suspended_at: null,
        })
      case `POST /app/installations/${installationId}/access_tokens`:
        return Response.json({
          token: 'r16-synthetic-installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      case `GET /repositories/${installationId}`:
        return Response.json({ id: Number(installationId), full_name: repositoryName })
      case `GET /repos/${repositoryName}/compare/${beforeSha}...${afterSha}?per_page=1&page=1`:
        return Response.json({
          base_commit: { sha: beforeSha },
          merge_base_commit: { sha: beforeSha },
          files: [
            {
              filename: targetPath,
              sha: blobSha,
              status: 'modified',
              additions: 2,
              deletions: 0,
              patch: '@@ -1 +1,3 @@\n # 事件循环\n+\n+当前任务结束后，先清空微任务队列。',
            },
          ],
        })
      case `GET /repos/${repositoryName}/contents/${targetPath}?ref=${afterSha}`:
        return Response.json({
          type: 'file',
          path: targetPath,
          sha: blobSha,
          size: bytes.length,
          encoding: 'base64',
          content: bytes.toString('base64'),
        })
      default:
        throw new Error(`Unexpected fixture route: ${route}`)
    }
  }
  return {
    calls,
    reader: new BoundCommitEvidenceReader(
      database,
      {
        GITHUB_APP_CLIENT_ID: 'r16-synthetic-app',
        GITHUB_APP_PRIVATE_KEY_PATH: resolve('fixture-only-never-read.pem'),
      },
      upstream,
      async () => pem,
    ),
  }
}
