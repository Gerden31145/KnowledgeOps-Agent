import type { ParsedNoteEvidence } from './parse-note-evidence.js'

// 不统计标题、原生 HTML、图片 alt 或链接目标 URL；代码块/行内代码计入。
// 返回的片段只是引用示例，characters 始终统计完整正文。
export function measureNoteContent(note: ParsedNoteEvidence) {
  let characters = 0
  const ranges: { startLine: number; endLine: number }[] = []
  const stack = [...note.tree.children].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'heading' || node.type === 'html') continue
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      const count = Array.from(node.value.replace(/\s/gu, '')).length
      characters += count
      const position = node.position
      if (
        count > 0 &&
        position &&
        ranges.length < 3 &&
        !ranges.some((range) => range.startLine === position.start.line)
      ) {
        ranges.push({
          startLine: position.start.line,
          endLine: Math.min(position.end.line, position.start.line + 4, note.lines.length),
        })
      }
    } else if ('children' in node) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        stack.push(node.children[index]!)
      }
    }
  }
  return { characters, ranges }
}
