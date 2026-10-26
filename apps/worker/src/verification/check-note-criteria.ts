import {
  contentMinimumConfigSchema,
  sectionPresentConfigSchema,
  type AcceptanceCriterionType,
  type CriterionResult,
} from '@knowledgeops/contracts'
import { findRequiredSection } from './find-required-section.exercise.js'
import { measureNoteContent } from './measure-note-content.js'
import {
  NoteEvidenceError,
  parseNoteEvidence,
  readNoteCitation,
  type NoteEvidenceInput,
} from './parse-note-evidence.js'

export interface NoteCriterion {
  id: string
  type: AcceptanceCriterionType
  config: unknown // 历史记录可能为 null；不因 TS 类型而信任持久化 JSON。
}

export interface DeterministicNoteReport {
  results: CriterionResult[]
  exemptions: { criterionId: string; reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE' }[]
  pendingCriterionIds: string[] // 语义标准和追问交给后续单元，不能在这里伪造通过。
}

// 只检查同一份已落库证据；不查 GitHub、不改 Task、不汇总任务是否通过。
export function checkNoteCriteria(input: {
  evidence: NoteEvidenceInput & { mode: string; change: string | null }
  criteria: readonly NoteCriterion[]
}): DeterministicNoteReport {
  const { evidence, criteria } = input
  const currentFile =
    evidence.mode === 'SNAPSHOT'
      ? evidence.change === null
      : evidence.mode === 'DIFF' && ['added', 'modified', 'renamed'].includes(evidence.change ?? '')
  // R06 删除证据只保留旧正文，不创建验收 Run；这里也拒绝拿旧正文验收当前文件。
  if (!currentFile) throw new NoteEvidenceError('INVALID_EVIDENCE')
  const note = parseNoteEvidence(evidence)
  const report: DeterministicNoteReport = { results: [], exemptions: [], pendingCriterionIds: [] }
  let measured: ReturnType<typeof measureNoteContent> | undefined

  for (const criterion of criteria) {
    const result: CriterionResult = {
      criterionId: criterion.id,
      outcome: 'INSUFFICIENT_EVIDENCE',
      rationale: '该标准缺少有效检查参数，无法确定是否满足。',
      suggestions: ['需要明确验收参数后再检查；不能根据描述猜测或默认通过。'],
      citations: [],
      confidence: 0,
    }
    if (criterion.type === 'FILE_CHANGED') {
      if (evidence.mode === 'SNAPSHOT') {
        report.exemptions.push({
          criterionId: criterion.id,
          reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE',
        })
        continue
      }
      result.outcome = 'PASSED'
      result.rationale = '已持久化的固定提交比较证据确认目标文件发生变化。'
    } else if (criterion.type === 'SECTION_PRESENT') {
      const config = sectionPresentConfigSchema.safeParse(criterion.config)
      if (!config.success) {
        report.results.push(result)
        continue
      }
      const location = findRequiredSection(note.tree, config.data.heading)
      result.outcome = location ? 'PASSED' : 'FAILED'
      result.rationale = location
        ? `找到章节“${config.data.heading}”。`
        : `未找到章节“${config.data.heading}”。`
      if (location)
        result.citations = [readNoteCitation(note, location.startLine, location.endLine)]
      else result.suggestions = [`请添加标题为“${config.data.heading}”的章节。`]
    } else if (criterion.type === 'CONTENT_MINIMUM') {
      const config = contentMinimumConfigSchema.safeParse(criterion.config)
      if (!config.success) {
        report.results.push(result)
        continue
      }
      measured ??= measureNoteContent(note)
      result.outcome = measured.characters >= config.data.minCharacters ? 'PASSED' : 'FAILED'
      result.rationale = `正文与代码包含 ${measured.characters} 个非空白字符，要求至少 ${config.data.minCharacters} 个。`
      result.citations = measured.ranges.map((range) =>
        readNoteCitation(note, range.startLine, range.endLine),
      )
      if (result.outcome === 'FAILED')
        result.suggestions = ['请补充正文或代码；达到内容量不代表解释正确。']
    } else {
      report.pendingCriterionIds.push(criterion.id)
      continue
    }
    result.confidence = 1
    if (result.outcome === 'PASSED') result.suggestions = []
    report.results.push(result)
  }
  return report
}
