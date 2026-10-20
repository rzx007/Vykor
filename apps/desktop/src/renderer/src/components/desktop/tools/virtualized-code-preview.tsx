import { areFilesEqual, DEFAULT_THEMES, type CodeViewItem, type FileContents } from "@pierre/diffs"
import { Editor, type EditorFactory, type EditorOptions } from "@pierre/diffs/edit"
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CodeViewProps,
  type CodeViewReactOptions,
} from "@pierre/diffs/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@renderer/components/ui/context-menu"
import { useEditorPreferences } from "@renderer/stores/editor-preferences"
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
import { saveCodePreviewDraft } from "./code-preview-save"
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
function textOffset(text: string, position: { line: number; character: number }): number {
  let start = 0
  for (let line = 0; line < position.line; line++) start = text.indexOf("\n", start) + 1
  return start + position.character
}
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
  const dirty = !!draft && draft.content !== draft.originalContent
  const saving = draft?.saving ?? false
  const canEdit =
    !!projectPath && preview.scope === "project" && !preview.binary && preview.content !== null
  const { readOnly, wordWrap, tabSize, update: updatePreferences } = useEditorPreferences()
  const editing = canEdit && !readOnly && (draft?.editing ?? false)
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const savingRef = useRef(false)
  const discarding = useRef(false)
  const restoreEditorFocus = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [hasSelection, setHasSelection] = useState(false)
  const [selectedText, setSelectedText] = useState("")
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
  const line = searchQuery && searchMatch ? searchMatch.line + 1 : targetLine
  const editStateKey = draft ? `desktop-code-draft:${draft.id}` : undefined
  const getEditStateKey = useCallback(() => editStateKey, [editStateKey])
  useEffect(() => {
    if (!canEdit) return
    const store = useCodePreviewDrafts.getState()
    const current = store.drafts[draftKey]
    if (readOnly) {
      if (current?.editing) store.stop(draftKey)
    } else if (!current?.editing) store.begin(draftKey, file.contents, preview)
  }, [canEdit, readOnly, draftKey, file, preview])
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
      overflow: wordWrap ? "wrap" : "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLineLength: codeHighlighterOptions.tokenizeMaxLineLength,
      unsafeCSS: `${codeViewerCSS}\n:host, pre { tab-size: ${tabSize}; }`,
    }),
    [themeType, wordWrap, tabSize]
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
      onAttach: (editor) =>
        editor.focus({ lineNumber: line ?? "first-visible", preventScroll: !line }),
    }),
    [scopeId, projectPath, preview.path, preview.language, draftKey, line]
  )

  useEffect(() => {
    const store = useCodePreviewDrafts.getState()
    const current = store.drafts[draftKey]
    // 返回聊天时 runtime 可能仍持有保存前的同一个预览对象；已保存草稿更近。
    if (current?.sourcePreview === preview) return
    if (
      current &&
      (current.saving ||
        current.content !== current.originalContent ||
        preview.content === current.originalContent)
    ) {
      store.rememberPreview(draftKey, preview)
      return
    }
    const timer = window.setTimeout(() => {
      if (current) {
        const latest = useCodePreviewDrafts.getState().drafts[draftKey]
        if (latest?.id !== current.id || latest.saving || latest.content !== latest.originalContent)
          return
        // 干净文件收到新的磁盘内容时，重建编辑会话，避免旧撤销历史覆盖新内容。
        discarding.current = true
        store.discard(draftKey)
        if (!readOnly && canEdit) store.begin(draftKey, preview.content ?? "", preview)
        setEpoch((value) => value + 1)
      }
      setFile({ ...createPreviewFile(preview), cacheKey: undefined })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [preview, draftKey, setFile, readOnly, canEdit])
  useEffect(() => {
    discarding.current = false
  }, [epoch])

  useEffect(() => {
    if (!line) return
    viewer.current?.scrollTo({
      type: "line",
      id: preview.path,
      lineNumber: line,
      align: "center",
      behavior: "instant",
    })
    if (editing) viewer.current?.getEditor(preview.path)?.focus({ lineNumber: line })
    else viewer.current?.setSelectedLines({ id: preview.path, range: { start: line, end: line } })
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
    setError(null)
    try {
      const result = await saveCodePreviewDraft(draftKey, projectPath, preview.path)
      if (result) onSaved?.(result)
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message.replace(/^Error invoking remote method '[^']+': /, "")
          : "保存失败，草稿仍已保留。"
      setError(message)
      toast.error("文件保存失败", message)
    } finally {
      savingRef.current = false
    }
  }

  const addSelectedLines = (): void => {
    restoreEditorFocus.current = false
    const editor = viewer.current?.getEditor(preview.path)
    const range = editor
      ?.getViewState()
      .selections?.find(
        ({ start, end }) => start.line !== end.line || start.character !== end.character
      )
    if (editor && range) {
      const text = editor.getText()
      addCodeSelectionToComposer(scopeId, {
        projectPath,
        path: preview.path,
        language: preview.language,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        startColumn: range.start.character + 1,
        endColumn: range.end.character + 1,
        text: text.slice(textOffset(text, range.start), textOffset(text, range.end)),
        unsaved: dirty,
      })
      return
    }
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

  const editorKey = (key: string) =>
    window.requestAnimationFrame(() => {
      viewer.current?.getEditor(preview.path)?.focus()
      const shadow = containerRef.current?.querySelector("diffs-container")?.shadowRoot
      const target = shadow?.activeElement
      const mac = navigator.platform.toLowerCase().includes("mac")
      target?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: !mac,
          metaKey: mac,
          bubbles: true,
          composed: true,
        })
      )
    })
  const clipboardAction = async (action: "copy" | "cut" | "paste") => {
    const editor = viewer.current?.getEditor(preview.path)
    if (!editor) {
      if (action === "copy" && selectedText) {
        try {
          await window.desktop.clipboard.writeText(selectedText)
        } catch {
          toast.error("无法访问剪贴板")
        }
      }
      return
    }
    const ranges = editor.getViewState().selections ?? []
    const text = editor.getText()
    try {
      if (action === "paste") {
        const newText = await window.desktop.clipboard.readText()
        if (viewer.current?.getEditor(preview.path) !== editor || editor.getText() !== text) return
        editor.applyEdits(ranges.map((range) => ({ range, newText })))
      } else {
        const selected = ranges
          .map((range) => text.slice(textOffset(text, range.start), textOffset(text, range.end)))
          .join("\n")
        if (!selected) return
        await window.desktop.clipboard.writeText(selected)
        if (
          action === "cut" &&
          viewer.current?.getEditor(preview.path) === editor &&
          editor.getText() === text
        )
          editor.applyEdits(ranges.map((range) => ({ range, newText: "" })))
      }
      editor.focus()
    } catch {
      toast.error("无法访问剪贴板")
    }
  }
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          restoreEditorFocus.current = true
          const editor = viewer.current?.getEditor(preview.path)
          setHistory({ undo: editor?.canUndo ?? false, redo: editor?.canRedo ?? false })
          setHasSelection(
            !!editor
              ?.getViewState()
              .selections?.some(
                ({ start, end }) => start.line !== end.line || start.character !== end.character
              )
          )
          setSelectedText(
            window.getSelection()?.toString() ||
              (selection
                ? file.contents
                    .split(/\r?\n/)
                    .slice(
                      Math.min(selection.range.start, selection.range.end) - 1,
                      Math.max(selection.range.start, selection.range.end)
                    )
                    .join("\n")
                : "")
          )
        }
      }}
    >
      <ContextMenuTrigger
        render={<div />}
        ref={containerRef}
        tabIndex={-1}
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
            containerRef.current?.focus()
          }
        }}
      >
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
              getEditStateKey={getEditStateKey}
              onItemEditChange={change}
              onItemEditComplete={complete}
              onSelectedLinesChange={setSelection}
              className="desktop-code-file min-h-0 min-w-0 flex-1"
            />
          </EditProvider>
        </CodeHighlightingProvider>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        finalFocus={() => {
          if (discardOpen || !restoreEditorFocus.current) return false
          if (editing) {
            window.requestAnimationFrame(() => viewer.current?.getEditor(preview.path)?.focus())
            return false
          }
          return containerRef.current
        }}
      >
        <ContextMenuItem disabled={!dirty || saving} onClick={() => void save()}>
          保存 <span className="ml-auto text-xs text-muted-foreground">{shortcut}S</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!editing || !history.undo}
          onClick={() => {
            viewer.current?.getEditor(preview.path)?.undo()
          }}
        >
          撤销 <span className="ml-auto text-xs text-muted-foreground">{shortcut}Z</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!editing || !history.redo}
          onClick={() => {
            viewer.current?.getEditor(preview.path)?.redo()
          }}
        >
          重做 <span className="ml-auto text-xs text-muted-foreground">{shortcut}Shift+Z</span>
        </ContextMenuItem>
        <div role="separator" className="my-1 h-px bg-border/70" />
        <ContextMenuItem
          disabled={!editing || !hasSelection}
          onClick={() => void clipboardAction("cut")}
        >
          剪切
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection && !selectedText}
          onClick={() => void clipboardAction("copy")}
        >
          复制
        </ContextMenuItem>
        <ContextMenuItem disabled={!editing} onClick={() => void clipboardAction("paste")}>
          粘贴
        </ContextMenuItem>
        <ContextMenuItem disabled={!editing} onClick={() => editorKey("a")}>
          全选
        </ContextMenuItem>
        <ContextMenuItem disabled={!editing} onClick={() => editorKey("f")}>
          查找 <span className="ml-auto text-xs text-muted-foreground">{shortcut}F</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={!editing} onClick={() => editorKey("h")}>
          替换 <span className="ml-auto text-xs text-muted-foreground">{shortcut}H</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={editing ? !hasSelection : !selection} onClick={addSelectedLines}>
          添加选区到输入框
        </ContextMenuItem>
        <div role="separator" className="my-1 h-px bg-border/70" />
        <ContextMenuItem
          role="menuitemcheckbox"
          aria-checked={readOnly}
          disabled={!canEdit}
          onClick={() => updatePreferences({ readOnly: !readOnly })}
        >
          {readOnly ? "✓ " : ""}只读
        </ContextMenuItem>
        <ContextMenuItem
          role="menuitemcheckbox"
          aria-checked={wordWrap}
          onClick={() => updatePreferences({ wordWrap: !wordWrap })}
        >
          {wordWrap ? "✓ " : ""}自动换行
        </ContextMenuItem>
        <ContextMenuItem
          destructive
          disabled={!dirty || saving}
          onClick={() => setDiscardOpen(true)}
        >
          放弃改动并重新载入
        </ContextMenuItem>
      </ContextMenuContent>
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
    </ContextMenu>
  )
}
