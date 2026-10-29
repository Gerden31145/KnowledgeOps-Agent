import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  answerVerificationCandidateSchema,
  noteVerificationCandidateSchema,
  type AnswerVerificationPort,
  type NoteVerificationPort,
  type NoteVerificationUsage,
} from '@knowledgeops/agent-core'
import { parseNoteEvidence, readNoteCitation } from '../../src/verification/parse-note-evidence.js'
import { verifyNoteSemantics } from '../../src/verification/verify-note-semantics.js'
import { verifyFollowUpAnswer } from '../../src/verification/verify-follow-up-answer.js'
import { cases, question, rubric, type EvalCase, type Outcome, type Range } from './cases.js'

export type PromptVersion = 'v1' | 'v2'
export const policy = {
  modelName: 'glm-5.3',
  reasoningEffort: 'low' as const,
  maxOutputTokens: 4096,
  timeoutMs: 90_000,
  maxCalls: 15,
  stopAfterCostMicrounits: 2_000_000,
  currency: 'CNY',
  inputMicrounitsPerToken: 8,
  outputMicrounitsPerToken: 28,
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
type Citation = { startLine: number; endLine: number; excerpt: string }
export const datasetHash = () => createHash('sha256').update(JSON.stringify(cases)).digest('hex')

// 显式选择业务字段，不能把样本名、标签、expected 或评分解释发给模型。
export function prepareCase(sample: EvalCase, version: PromptVersion) {
  const lines = sample.note.split(/\r\n|\n|\r/)
  const contentHash = createHash('sha256').update(sample.note).digest('hex')
  const note = parseNoteEvidence({
    repositoryId: id(1),
    path: 'notes/evaluation.md',
    sourceCommitSha: contentHash.slice(0, 40),
    content: sample.note,
    contentHash,
    lineCount: lines.length,
  })
  const task = {
    id: id(2),
    title: '解释学习笔记中的知识',
    description: '根据所给笔记和指定标准进行验收。',
  }
  const model = {
    catalogId: 'glm-5-3',
    provider: 'openai',
    modelName: policy.modelName,
    reasoningEffort: policy.reasoningEffort,
    promptVersion: `note-verification-${version}`,
    outputSchemaVersion: 'note-verification-output-v1',
  }
  const noteInput = {
    runId: id(3),
    task,
    model,
    note,
    criteria: sample.criteria.map((criterion, index) => ({ id: id(10 + index), ...criterion })),
  }
  const answerInput =
    sample.answer === undefined
      ? null
      : {
          runId: id(4),
          task,
          note,
          model: {
            ...model,
            promptVersion: `answer-verification-${version}`,
            outputSchemaVersion: 'answer-verification-output-v1',
          },
          question: {
            id: id(5),
            criterionId: id(20),
            question,
            rubric,
            source: {
              ...note.source,
              taskId: task.id,
              submissionId: id(6),
              noteRunId: id(3),
              reportId: id(7),
            },
            citations: [readNoteCitation(note, 3, 4)],
          },
          answer: { id: id(8), questionId: id(5), content: sample.answer },
        }
  return { noteInput, answerInput }
}

export function checkCases() {
  assert.equal(cases.length, policy.maxCalls)
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
  for (const sample of cases) {
    const { noteInput } = prepareCase(sample, 'v2')
    assert.equal(sample.expected.length, sample.answer === undefined ? sample.criteria.length : 1)
    for (const expected of sample.expected) {
      for (const [start, end] of expected.noteRanges)
        assert(readNoteCitation(noteInput.note, start, end).excerpt.trim())
      for (const [start, end] of expected.answerRanges ?? []) {
        const lines = sample.answer!.split(/\r\n|\n|\r/)
        assert(start > 0 && end >= start && end <= lines.length)
        assert(
          lines
            .slice(start - 1, end)
            .join('\n')
            .trim(),
        )
      }
      if (expected.outcome !== 'INSUFFICIENT_EVIDENCE') assert(expected.noteRanges.length > 0)
    }
  }
}

export interface Observation {
  id: string
  expected: Outcome[]
  actual: Outcome[] | null
  schemaValid: boolean
  errorCode: string | null
  citations: { valid: number; total: number }
  relevantRanges: { covered: number; total: number }
  usage: NoteVerificationUsage | null
  costMicrounits: number | null
  durationMs: number
}
const locatable = (lines: string[], c: Citation) =>
  c.startLine >= 1 &&
  c.endLine >= c.startLine &&
  c.endLine <= lines.length &&
  Boolean(c.excerpt.trim()) &&
  lines.slice(c.startLine - 1, c.endLine).join('\n') === c.excerpt
function coverage(ranges: Range[], citations: Citation[]) {
  return ranges.filter(([start, end]) => {
    for (let line = start; line <= end; line++)
      if (!citations.some((c) => c.startLine <= line && line <= c.endLine)) return false
    return true
  }).length
}

export async function evaluateCase(
  sample: EvalCase,
  version: PromptVersion,
  ports: { note: NoteVerificationPort; answer: AnswerVerificationPort },
): Promise<Observation> {
  const started = performance.now()
  const { noteInput, answerInput } = prepareCase(sample, version)
  const row: Observation = {
    id: sample.id,
    expected: sample.expected.map((e) => e.outcome),
    actual: null,
    schemaValid: false,
    errorCode: null,
    citations: { valid: 0, total: 0 },
    relevantRanges: {
      covered: 0,
      total: sample.expected.reduce(
        (sum, e) =>
          sum +
          (e.outcome === 'INSUFFICIENT_EVIDENCE'
            ? 0
            : e.noteRanges.length + (e.answerRanges?.length ?? 0)),
        0,
      ),
    },
    usage: null,
    costMicrounits: null,
    durationMs: 0,
  }
  const options = {
    signal: AbortSignal.timeout(policy.timeoutMs),
    maxOutputTokens: policy.maxOutputTokens,
  }
  // 保存候选的引用统计，即使正式业务校验随后拒绝它，也不能隐藏坏引用。
  function observe(value: unknown, usage: NoteVerificationUsage | null) {
    row.usage = usage
    const parsed = answerInput
      ? answerVerificationCandidateSchema.safeParse(value)
      : noteVerificationCandidateSchema.safeParse(value)
    row.schemaValid = parsed.success
    if (!parsed.success) return
    const results = 'results' in parsed.data ? parsed.data.results : [parsed.data]
    for (const result of results) {
      row.citations.total += result.citations.length
      row.citations.valid += result.citations.filter((c) =>
        locatable(noteInput.note.lines, c),
      ).length
      if ('answerCitations' in result) {
        row.citations.total += result.answerCitations.length
        row.citations.valid += result.answerCitations.filter((c) =>
          locatable(sample.answer!.split(/\r\n|\n|\r/), c),
        ).length
      }
    }
    for (const [index, expected] of sample.expected.entries()) {
      const result = answerInput
        ? results[0]
        : results.find((r) => 'criterionId' in r && r.criterionId === id(10 + index))
      if (!result) continue
      const groups = [
        { lines: noteInput.note.lines, citations: result.citations, ranges: expected.noteRanges },
        ...('answerCitations' in result
          ? [
              {
                lines: sample.answer!.split(/\r\n|\n|\r/),
                citations: result.answerCitations,
                ranges: expected.answerRanges ?? [],
              },
            ]
          : []),
      ]
      for (const group of groups) {
        const valid = group.citations.filter((c) => locatable(group.lines, c))
        if (expected.outcome !== 'INSUFFICIENT_EVIDENCE') {
          row.relevantRanges.covered += coverage(group.ranges, valid)
        }
      }
    }
  }
  try {
    if (answerInput) {
      const result = await verifyFollowUpAnswer(
        {
          verify: async (request, opts) => {
            const response = await ports.answer.verify(request, opts)
            observe(response.candidate, response.usage)
            return response
          },
        },
        answerInput,
        options,
      )
      row.actual = [result.result.outcome]
    } else {
      const result = await verifyNoteSemantics(
        {
          verify: async (request, opts) => {
            const response = await ports.note.verify(request, opts)
            observe(response.candidate, response.usage)
            return response
          },
        },
        noteInput,
        options,
      )
      row.actual = result.results.map((r) => r.outcome)
    }
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; usage?: NoteVerificationUsage | null }
    row.errorCode =
      typeof e.code === 'string' && /^[A-Z_]{1,64}$/.test(e.code) ? e.code : 'EVALUATION_ERROR'
    row.usage ??= e.usage ?? null
  }
  row.durationMs = Math.round(performance.now() - started)
  if (row.usage)
    row.costMicrounits =
      row.usage.inputTokens * policy.inputMicrounitsPerToken +
      row.usage.outputTokens * policy.outputMicrounitsPerToken
  return row
}

// 技术失败仍占预期结论分母，不算作 INSUFFICIENT_EVIDENCE，不丢掉失败调用费用。
export function summarize(rows: Observation[], planned = cases.length) {
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  })
  let expectedCount = 0,
    matched = 0,
    nonPassing = 0,
    falsePasses = 0,
    insufficient = 0,
    actualCount = 0
  for (const row of rows)
    for (const [index, expected] of row.expected.entries()) {
      expectedCount++
      const actual = row.actual?.[index]
      if (actual === expected) matched++
      if (expected !== 'PASSED') {
        nonPassing++
        if (actual === 'PASSED') falsePasses++
      }
      if (actual) actualCount++
      if (actual === 'INSUFFICIENT_EVIDENCE') insufficient++
    }
  const known = rows.filter((r) => r.usage !== null && r.costMicrounits !== null)
  const totalTokens = known.reduce((sum, r) => sum + r.usage!.totalTokens, 0)
  const totalCostMicrounits = known.reduce((sum, r) => sum + r.costMicrounits!, 0)
  return {
    planned,
    attempted: rows.length,
    unattempted: planned - rows.length,
    technicalFailures: rows.filter((r) => r.errorCode !== null).length,
    schemaSuccess: rate(rows.filter((r) => r.schemaValid).length, rows.length),
    conclusionAgreement: rate(matched, expectedCount),
    citationLocatability: rate(
      rows.reduce((s, r) => s + r.citations.valid, 0),
      rows.reduce((s, r) => s + r.citations.total, 0),
    ),
    relevantRangeCoverage: rate(
      rows.reduce((s, r) => s + r.relevantRanges.covered, 0),
      rows.reduce((s, r) => s + r.relevantRanges.total, 0),
    ),
    falsePassRate: rate(falsePasses, nonPassing),
    insufficientRate: rate(insufficient, actualCount),
    totalTokens,
    totalCostMicrounits,
    unknownUsageCalls: rows.length - known.length,
    averageTokens: known.length ? totalTokens / known.length : null,
    averageCostMicrounits: known.length ? totalCostMicrounits / known.length : null,
    averageDurationMs: rows.length
      ? rows.reduce((s, r) => s + r.durationMs, 0) / rows.length
      : null,
  }
}
