export interface CodeSelectionContext {
  projectPath?: string | null
  path: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  text: string
  unsaved: boolean
}

export function codeSelectionText(selection: CodeSelectionContext): string {
  // 围栏比内容中的反引号更长，选中的 Markdown 代码也能完整作为上下文。
  let ticks = 3
  for (const match of selection.text.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1)
  const fence = "`".repeat(ticks)
  const location = `${selection.path}:${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`
  const language = selection.language.replace(/[^\w#+.-]/g, "")
  return `\n\n${selection.projectPath ? `项目：${selection.projectPath}\n` : ""}文件：${location}${selection.unsaved ? "（未保存的编辑内容）" : ""}\n${fence}${language}\n${selection.text}\n${fence}\n`
}
