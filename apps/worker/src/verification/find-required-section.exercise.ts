import { toString } from 'mdast-util-to-string'
import type { ParsedNoteEvidence } from './parse-note-evidence.js'

export interface SectionLocation {
  startLine: number
  endLine: number
}

// 提供文字提取，避免小手写还要自己解析加粗、链接或行内代码。
// 此函数不负责寻找标题或比较是否匹配。
export function headingText(node: unknown): string {
  return toString(node, { includeImageAlt: false, includeHtml: false }).trim()
}

// 小手写：在文档第一层的真实标题中，寻找与 expectedHeading 完全匹配的第一个。
// 返回该标题的原文行范围；没有找到返回 null。R08 小手写已通过 Review。
export function findRequiredSection(
  tree: ParsedNoteEvidence['tree'],
  expectedHeading: string,
): SectionLocation | null {
  for (const node of tree.children) {
    if (node.type === 'heading' && headingText(node) === expectedHeading && node.position)
      return {
        startLine: node.position.start.line,
        endLine: node.position.end.line,
      }
  }
  return null
}
