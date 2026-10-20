import { areFilesEqual, DEFAULT_THEMES, type CodeViewItem, type FileContents } from "@pierre/diffs"
import { Editor, type EditorFactory, type EditorOptions } from "@pierre/diffs/edit"
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CodeViewProps,
  type CodeViewReactOptions,
} from "@pierre/diffs/react"
import { Check, MessageCirclePlus, Pencil, Save, Undo2, WrapText } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import { CodeHighlightingProvider } from "@renderer/components/ui/code-highlighting-provider"
import { codeHighlighterOptions } from "@renderer/lib/code-highlight-options"
import { toast } from "@renderer/lib/toast"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { createPreviewFile } from "./virtualized-code-preview-model"
import { useCodePreviewDrafts } from "./code-preview-drafts"
import { addCodeSelectionToComposer, createCodeSelectionAction } from "./code-selection-actions"
import type { FileSearchMatch } from "./file-viewer"

interface VirtualizedCodePreviewProps {
  preview: WorkspaceReadFileResult
  themeType: "dark" | "light"
  searchQuery: string
  searchMatch?: FileSearchMatch
  targetLine?: number
  scopeId: string
  projectPath?: string | null
  onSaved?: (preview: WorkspaceReadFileResult) => void
}

const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
  new Editor(type, options, key)
const codeViewerCSS = `
  :host {
    display: block;
    background: transparent;
    color: var(--content-foreground);
    font-family: var(--font-mono);
    font-size: var(--code-font-size);
    line-height: var(--code-line-height);
    tab-size: 2;
  }
  pre {
    margin: 0;
    background: transparent !important;
    font-family: var(--font-mono) !important;
    font-size: var(--code-font-size) !important;
    line-height: var(--code-line-height) !important;
    tab-size: 2;
  }
  .code-selection-actions {
    display: flex; flex-wrap: wrap; gap: 2px; padding: 6px;
    border: 1px solid var(--border); border-radius: 16px;
    background: var(--popover); color: var(--popover-foreground);
    box-shadow: 0 4px 16px color-mix(in srgb, var(--foreground) 10%, transparent);
    font: 12px/1.5 var(--font-sans);
  }
  .code-selection-actions button {
    border: 0; border-radius: 999px; padding: 5px 9px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .code-selection-actions button:hover { background: var(--muted); }
  .code-selection-actions button:focus-visible { outline: 2px solid var(--ring); }
  .code-selection-actions button:disabled { opacity: .5; cursor: wait; }
`

export function VirtualizedCodePreview({
  preview,
  themeType,
  searchQuery,
  searchMatch,
  targetLine,
  scopeId,
  projectPath,
  onSaved,
}: VirtualizedCodePreviewProps): React.JSX.Element {
  const draftKey = JSON.stringify([scopeId, projectPath, preview.path])
  const draft = useCodePreviewDrafts((state) => state.drafts[draftKey])
  const editing = draft?.editing ?? false
  const dirty = !!draft && draft.content !== draft.originalContent
  const saving = draft?.saving ?? false
  const canEdit =
    !!projectPath && preview.scope === "project" && !preview.binary && preview.content !== null
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const savingRef = useRef(false)
  const discarding = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [selection, setSelection] = useState<{
    id: string
    range: { start: number; end: number }
  } | null>(null)
  const [document, setDocument] = useState(() => ({
    file: {
      ...createPreviewFile(preview),
      contents: draft?.content ?? preview.content ?? "",
      cacheKey: undefined,
    } as FileContents,
    version: 0,
  }))
  const file = document.file
  // 保存回传可能只更新元数据；内容未变时保留布局正在使用的文件对象。
  const setFile = useCallback(
    (next: FileContents) =>
      setDocument((current) =>
        areFilesEqual(current.file, next) ? current : { file: next, version: current.version + 1 }
      ),
    []
  )
  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [
      {
        id: preview.path,
        type: "file",
        file,
        edit: editing,
        version: document.version * 2 + (editing ? 1 : 0),
      },
    ],
    [preview.path, file, editing, document.version]
  )
  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      disableFileHeader: true,
      enableLineSelection: true,
      overflow: wrap ? "wrap" : "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLineLength: codeHighlighterOptions.tokenizeMaxLineLength,
      unsafeCSS: codeViewerCSS,
    }),
    [themeType, wrap]
  )
  const editorOptions = useMemo<EditorOptions<"file" | "file-diff", undefined, undefined>>(
    () => ({
      clipboard: { readText: () => window.desktop.clipboard.readText() },
      keymap: [{ bindings: { "cmdOrCtrl+h": "openSearchReplacePanel" } }],
      enabledSelectionAction: true,
      renderSelectionAction: createCodeSelectionAction({
        scopeId,
        projectPath,
        path: preview.path,
        language: preview.language,
        isUnsaved: () => {
          const current = useCodePreviewDrafts.getState().drafts[draftKey]
          return !!current && current.content !== current.originalContent
        },
      }),
      onAttach: (editor) => editor.focus({ lineNumber: "first-visible", preventScroll: true }),
    }),
    [scopeId, projectPath, preview.path, preview.language, draftKey]
  )

  useEffect(() => {
    const store = useCodePreviewDrafts.getState()
    const current = store.drafts[draftKey]
    // 返回聊天时 runtime 可能仍持有保存前的同一个预览对象；已保存草稿更近。
    if (current?.sourcePreview === preview) return
    if (
      current &&
      (current.editing || current.saving || current.content !== current.originalContent)
    ) {
      store.rememberPreview(draftKey, preview)
      return
    }
    if (current) store.discard(draftKey)
    const timer = window.setTimeout(
      () => setFile({ ...createPreviewFile(preview), cacheKey: undefined }),
      0
    )
    return () => window.clearTimeout(timer)
  }, [preview, draftKey, setFile])
  useEffect(() => {
    discarding.current = false
  }, [epoch])

  const line = searchQuery && searchMatch ? searchMatch.line + 1 : targetLine
  useEffect(() => {
    if (!line || editing) return
    viewer.current?.scrollTo({
      type: "line",
      id: preview.path,
      lineNumber: line,
      align: "center",
      behavior: "instant",
    })
    viewer.current?.setSelectedLines({ id: preview.path, range: { start: line, end: line } })
  }, [line, searchMatch?.index, preview.path, editing])

  const change = useCallback<NonNullable<CodeViewProps<undefined, undefined>["onItemEditChange"]>>(
    (event) => {
      useCodePreviewDrafts.getState().change(draftKey, event.file.contents)
    },
    [draftKey]
  )
  const complete = useCallback<
    NonNullable<CodeViewProps<undefined, undefined>["onItemEditComplete"]>
  >(
    (_event, _item, nextItem) => {
      if (discarding.current) return "reject"
      if (nextItem.type === "file") {
        useCodePreviewDrafts.getState().change(draftKey, nextItem.file.contents)
        // 与 Pierre 接受的结果共用对象，并推进版本供下次编辑使用。
        setDocument((current) => ({ file: nextItem.file, version: current.version + 1 }))
      }
      return "accept"
    },
    [draftKey]
  )
  const save = async (): Promise<void> => {
    const current = useCodePreviewDrafts.getState().drafts[draftKey]
    if (
      !canEdit ||
      !projectPath ||
      !current ||
      current.saving ||
      savingRef.current ||
      current.content === current.originalContent
    )
      return
    savingRef.current = true
    useCodePreviewDrafts.getState().startSave(draftKey)
    setError(null)
    try {
      const result = await window.desktop.workspace.writeFile({
        rootPath: projectPath,
        path: preview.path,
        originalContent: current.originalContent,
        content: current.content,
      })
      useCodePreviewDrafts.getState().saved(draftKey, current.content, current.id)
      onSaved?.(result)
      toast.success("文件已保存")
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message.replace(/^Error invoking remote method '[^']+': /, "")
          : "保存失败，草稿仍已保留。"
      setError(message)
      toast.error("文件保存失败", message)
    } finally {
      savingRef.current = false
      useCodePreviewDrafts.getState().finishSave(draftKey, current.id)
    }
  }

  const addSelectedLines = (): void => {
    if (!selection) return
    const lines = file.contents.split(/\r?\n/)
    const startLine = Math.min(selection.range.start, selection.range.end)
    const endLine = Math.max(selection.range.start, selection.range.end)
    try {
      addCodeSelectionToComposer(scopeId, {
        projectPath,
        path: preview.path,
        language: preview.language,
        startLine,
        endLine,
        startColumn: 1,
        endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
        text: lines
          .slice(startLine - 1, endLine)
          .join(file.contents.includes("\r\n") ? "\r\n" : "\n"),
        unsaved: dirty,
      })
    } catch (selectionError) {
      toast.error(selectionError instanceof Error ? selectionError.message : "无法添加代码")
    }
  }

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-code-editing={editing}
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          event.stopPropagation()
          void save()
        }
        if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
          event.preventDefault()
          event.stopPropagation()
          editButton.current?.focus()
        }
      }}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/45 px-2 text-xs text-muted-foreground">
        {canEdit ? (
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            shape="pill"
            aria-pressed={editing}
            onClick={() => {
              const store = useCodePreviewDrafts.getState()
              if (editing) store.stop(draftKey)
              else store.begin(draftKey, file.contents, preview)
            }}
          >
            {editing ? <Check /> : <Pencil />}
            {editing ? "完成编辑" : "编辑"}
          </Button>
        ) : (
          <span className="px-2">只读</span>
        )}
        {draft ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              <Save />
              {saving ? "正在保存" : "保存"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              disabled={!dirty || saving}
              onClick={() => setDiscardOpen(true)}
            >
              <Undo2 />
              放弃改动
            </Button>
            {dirty ? (
              <span role="status" className="px-1">
                未保存
              </span>
            ) : null}
          </>
        ) : null}
        {!editing && selection ? (
          <Button variant="ghost" size="sm" shape="pill" onClick={addSelectedLines}>
            <MessageCirclePlus />
            添加到输入框
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          shape="circle"
          aria-label="自动换行"
          title="自动换行"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
          className="ml-auto"
        >
          <WrapText />
        </Button>
        {editing ? (
          <span
            className="w-full px-2 pb-1"
            title="Ctrl / Cmd + M 返回工具栏，再按 Tab 可离开编辑器"
          >
            Ctrl / Cmd + F 查找 · H 替换 · S 保存 · M 返回工具栏
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <CodeHighlightingProvider>
        <EditProvider createEditor={createEditor}>
          <CodeView
            key={epoch}
            ref={viewer}
            items={items}
            options={options}
            editorOptions={editorOptions}
            onItemEditChange={change}
            onItemEditComplete={complete}
            onSelectedLinesChange={setSelection}
            className="desktop-code-file min-h-0 min-w-0 flex-1"
          />
        </EditProvider>
      </CodeHighlightingProvider>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的改动？</AlertDialogTitle>
            <AlertDialogDescription>
              这会移除当前文件的编辑草稿，并重新读取磁盘上的内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留草稿</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (!projectPath || savingRef.current) return
                try {
                  const result = await window.desktop.workspace.readFile({
                    rootPath: projectPath,
                    path: preview.path,
                  })
                  discarding.current = true
                  useCodePreviewDrafts.getState().discard(draftKey)
                  setEpoch((current) => current + 1)
                  onSaved?.(result)
                  setFile({ ...createPreviewFile(result), cacheKey: undefined })
                  setError(null)
                  setDiscardOpen(false)
                } catch {
                  toast.error("重新读取失败，草稿仍已保留。")
                }
              }}
            >
              放弃并重新读取
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
