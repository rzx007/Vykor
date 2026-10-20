import { useCodePreviewDrafts } from "./code-preview-drafts"

export async function saveCodePreviewDraft(key: string, rootPath: string, path: string) {
  const current = useCodePreviewDrafts.getState().drafts[key]
  if (!current || current.content === current.originalContent) return null
  if (current.saving) throw new Error("文件正在保存。")
  useCodePreviewDrafts.getState().startSave(key)
  try {
    const result = await window.desktop.workspace.writeFile({
      rootPath,
      path,
      originalContent: current.originalContent,
      content: current.content,
    })
    useCodePreviewDrafts.getState().saved(key, current.content, current.id)
    return result
  } finally {
    useCodePreviewDrafts.getState().finishSave(key, current.id)
  }
}
