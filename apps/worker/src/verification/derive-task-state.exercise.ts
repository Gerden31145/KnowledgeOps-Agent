import type { TaskState } from '@knowledgeops/contracts'
import type { TaskCriterionAssessment } from './collect-task-assessment.js'

export type AssessedTaskState = Extract<TaskState, 'NEEDS_REVISION' | 'NEEDS_EVIDENCE' | 'PASSED'>

// 输入来自 collectTaskAssessment：标准归属、唯一必答追问、合法免检已由外围核对。
// 这里只返回业务判断，不修改输入、不访问数据库；笔记/回答 Finalizer 调用后原子写回。
// 题面：docs/handwrite/r11-task-state.md
export function deriveTaskState(
  assessments: readonly TaskCriterionAssessment[],
): AssessedTaskState {
  let state: AssessedTaskState = 'PASSED'
  for (const assessment of assessments) {
    if (!assessment.required || assessment.exemption) continue
    // NEEDS_REVISION
    if (
      assessment.type === 'CONTENT_MINIMUM' ||
      assessment.type === 'FILE_CHANGED' ||
      assessment.type === 'TOPIC_COVERAGE' ||
      assessment.type === 'SECTION_PRESENT'
    ) {
      if (assessment.outcome === 'FAILED') {
        state = 'NEEDS_REVISION'
        continue
      }
    }
    if (assessment.type === 'EXPLANATION_QUALITY' || assessment.type === 'SEMANTIC_CORRECTNESS') {
      if (assessment.outcome === 'FAILED') {
        state = 'NEEDS_REVISION'
        continue
      }
    }

    // 最高级状态已确定
    if (state === 'NEEDS_REVISION') continue
    // NEEDS_EVIDENCE
    if (
      assessment.type === 'CONTENT_MINIMUM' ||
      assessment.type === 'FILE_CHANGED' ||
      assessment.type === 'TOPIC_COVERAGE' ||
      assessment.type === 'SECTION_PRESENT'
    ) {
      if (assessment.outcome === null || assessment.outcome === 'INSUFFICIENT_EVIDENCE') {
        state = 'NEEDS_EVIDENCE'
        continue
      }
    }
    if (assessment.type === 'EXPLANATION_QUALITY' || assessment.type === 'SEMANTIC_CORRECTNESS') {
      if (assessment.outcome === 'INSUFFICIENT_EVIDENCE' || assessment.outcome === null) {
        state = 'NEEDS_EVIDENCE'
        continue
      }
    }
    if (assessment.type === 'FOLLOW_UP_ANSWER') {
      if (assessment.outcome !== 'PASSED') {
        state = 'NEEDS_EVIDENCE'
        continue
      }
    }
  }

  return state
}
