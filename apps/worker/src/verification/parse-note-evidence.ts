import { createHash } from 'node:crypto'
import {
  entityIdSchema,
  markdownTargetPathSchema,
  type NoteCitation,
} from '@knowledgeops/contracts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { z } from 'zod'

const evidenceInputSchema = z.object({
  repositoryId: entityIdSchema,
  path: markdownTargetPathSchema,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  content: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  lineCount: z.number().int().nonnegative(),
})

export type NoteEvidenceInput = z.infer<typeof evidenceInputSchema>
export interface ParsedNoteEvidence {
  source: { repositoryId: string; commitSha: string; path: string; contentHash: string }
  tree: ReturnType<typeof fromMarkdown>
  lines: string[]
}

export class NoteEvidenceError extends Error {
  override readonly name = 'NoteEvidenceError'

  constructor(readonly code: 'INVALID_EVIDENCE' | 'INVALID_CITATION') {
    super(code)
  }
}

// 调用方用 Submission 的仓库/路径与 Evidence 的正文/来源 SHA 组装输入。
// 不重新请求 GitHub；不判断任务通过，也不执行 Markdown 中的代码或 HTML。
export function parseNoteEvidence(input: NoteEvidenceInput): ParsedNoteEvidence {
  const parsed = evidenceInputSchema.safeParse(input)
  if (!parsed.success) throw new NoteEvidenceError('INVALID_EVIDENCE')
  const evidence = parsed.data
  const bytes = Buffer.from(evidence.content, 'utf8')
  // 与 R06 允许的最大文件范围一致，检查发生在解析之前。
  if (
    bytes.length > 1_000_000 ||
    evidence.content.includes('\0') ||
    createHash('sha256').update(bytes).digest('hex') !== evidence.contentHash
  ) {
    throw new NoteEvidenceError('INVALID_EVIDENCE')
  }

  // 仅为逐行引用拆分副本；解析时仍传原文，保留前导空行、CRLF 与原始位置。
  const lines =
    evidence.content === ''
      ? []
      : evidence.content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/)
  if (lines.length !== evidence.lineCount) throw new NoteEvidenceError('INVALID_EVIDENCE')

  return {
    source: {
      repositoryId: evidence.repositoryId,
      commitSha: evidence.sourceCommitSha,
      path: evidence.path,
      contentHash: evidence.contentHash,
    },
    tree: fromMarkdown(evidence.content),
    lines,
  }
}

// 行号为从 1 开始的闭区间。excerpt 从固定正文提取，不采信模型自行生成的引文。
export function readNoteCitation(
  note: ParsedNoteEvidence,
  startLine: number,
  endLine: number,
): NoteCitation {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > note.lines.length
  ) {
    throw new NoteEvidenceError('INVALID_CITATION')
  }
  return {
    ...note.source,
    startLine,
    endLine,
    excerpt: note.lines.slice(startLine - 1, endLine).join('\n'),
  }
}
