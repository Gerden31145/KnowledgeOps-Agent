import type { NoteCitation, NoteRunEvidenceResponse } from '@knowledgeops/contracts'

// 与 Worker 的引用行号一致：保留空行，仅去掉一个末尾换行，兼容 CRLF/LF/CR。
export function noteEvidenceLines(evidence: NoteRunEvidenceResponse): string[] {
  const lines =
    evidence.content === ''
      ? []
      : evidence.content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/)
  if (lines.length !== evidence.lineCount) throw new Error('固定证据的行数不一致。')
  return lines
}

export function matchesNoteCitation(
  evidence: NoteRunEvidenceResponse,
  lines: string[],
  citation: NoteCitation,
): boolean {
  return (
    citation.repositoryId === evidence.repositoryId &&
    citation.commitSha === evidence.sourceCommitSha &&
    citation.path === evidence.path &&
    citation.contentHash === evidence.contentHash &&
    Number.isInteger(citation.startLine) &&
    Number.isInteger(citation.endLine) &&
    citation.startLine >= 1 &&
    citation.endLine >= citation.startLine &&
    citation.endLine <= lines.length &&
    citation.excerpt === lines.slice(citation.startLine - 1, citation.endLine).join('\n')
  )
}
