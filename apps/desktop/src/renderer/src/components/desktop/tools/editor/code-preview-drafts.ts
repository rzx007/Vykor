import { create } from "zustand"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

interface CodePreviewDraft {
  id: number
  originalContent: string
  content: string
  editing: boolean
  saving: boolean
  sourcePreview?: WorkspaceReadFileResult
}
interface CodePreviewDraftStore {
  drafts: Record<string, CodePreviewDraft>
  begin(key: string, content: string, preview?: WorkspaceReadFileResult): void
  rememberPreview(key: string, preview: WorkspaceReadFileResult): void
  change(key: string, content: string): void
  startSave(key: string): void
  saved(key: string, content: string, id?: number): void
  finishSave(key: string, id: number): void
  stop(key: string): void
  discard(key: string): void
  moveScope(from: string, to: string): void
}

let draftSequence = 0
function draftKeyForId(
  drafts: CodePreviewDraftStore["drafts"],
  key: string,
  id?: number
): string | undefined {
  return id === undefined || drafts[key]?.id === id
    ? key
    : Object.keys(drafts).find((candidate) => drafts[candidate]?.id === id)
}

// 独立于当前挂载的文件：切换文件、Markdown 预览或工具面板时仍保留草稿。
export const useCodePreviewDrafts = create<CodePreviewDraftStore>((set) => ({
  drafts: {},
  begin: (key, content, preview) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: {
          ...(state.drafts[key] ?? {
            id: ++draftSequence,
            originalContent: content,
            content,
            saving: false,
          }),
          ...(preview ? { sourcePreview: preview } : {}),
          editing: true,
        },
      },
    })),
  rememberPreview: (key, preview) =>
    set((state) => {
      const draft = state.drafts[key]
      return draft && draft.sourcePreview !== preview
        ? { drafts: { ...state.drafts, [key]: { ...draft, sourcePreview: preview } } }
        : state
    }),
  change: (key, content) =>
    set((state) => {
      const draft = state.drafts[key]
      return draft ? { drafts: { ...state.drafts, [key]: { ...draft, content } } } : state
    }),
  startSave: (key) =>
    set((state) => {
      const draft = state.drafts[key]
      return draft ? { drafts: { ...state.drafts, [key]: { ...draft, saving: true } } } : state
    }),
  saved: (key, content, id) =>
    set((state) => {
      const resolvedKey = draftKeyForId(state.drafts, key, id)
      if (!resolvedKey) return state
      const draft = state.drafts[resolvedKey]
      return draft
        ? { drafts: { ...state.drafts, [resolvedKey]: { ...draft, originalContent: content } } }
        : state
    }),
  finishSave: (key, id) =>
    set((state) => {
      const resolvedKey = draftKeyForId(state.drafts, key, id)
      if (!resolvedKey) return state
      const draft = state.drafts[resolvedKey]
      return draft
        ? { drafts: { ...state.drafts, [resolvedKey]: { ...draft, saving: false } } }
        : state
    }),
  stop: (key) =>
    set((state) => {
      const draft = state.drafts[key]
      return draft ? { drafts: { ...state.drafts, [key]: { ...draft, editing: false } } } : state
    }),
  discard: (key) =>
    set((state) => {
      const drafts = { ...state.drafts }
      delete drafts[key]
      return { drafts }
    }),
  moveScope: (from, to) =>
    set((state) => {
      const drafts = { ...state.drafts }
      for (const [key, draft] of Object.entries(drafts)) {
        let parts: unknown
        try {
          parts = JSON.parse(key)
        } catch {
          continue
        }
        if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== from) continue
        const nextKey = JSON.stringify([to, parts[1], parts[2]])
        drafts[nextKey] ??= draft
        delete drafts[key]
      }
      return { drafts }
    }),
}))
