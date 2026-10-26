import { createHash } from 'node:crypto'

export function noteEvidence(content: string) {
  return {
    repositoryId: '11111111-1111-4111-8111-111111111111',
    path: 'notes/event-loop.md',
    sourceCommitSha: 'b'.repeat(40),
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    lineCount:
      content === '' ? 0 : content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).length,
    mode: 'DIFF',
    change: 'modified',
  }
}
