import { useEffect, useRef } from "react"
import { CircleAlert, Copy, Ellipsis, RotateCcw, Trash2 } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { Textarea } from "@renderer/components/ui/textarea"
import type { NoteView } from "./note-model"
import type { NoteSaveStatus } from "./note-save-coordinator"

export function NoteEditor({
  selected,
  content,
  status,
  error,
  onChange,
  onRetry,
  onReloadConflict,
  onSaveConflictAsNew,
  onDelete,
}: {
  selected: NoteView | undefined
  content: string
  status: "loading" | NoteSaveStatus
  error: string | null
  onChange: (content: string) => void
  onRetry: () => void
  onReloadConflict: () => void
  onSaveConflictAsNew: () => void
  onDelete: () => void
}): React.JSX.Element {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (status !== "loading") editorRef.current?.focus()
  }, [selected?.draftId, status])

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border/60 px-5">
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {saveLabel(status, selected)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{content.length} 字</span>
        {selected && (selected.noteId || content.trim()) ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-2"
                  aria-label="便签操作"
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 />
                  删除便签
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive" className="mx-5 mt-4 w-auto">
          <CircleAlert />
          <AlertTitle>{status === "conflict" ? "便签内容发生冲突" : "保存失败"}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction className="flex gap-1">
            {status === "conflict" ? (
              <>
                <Button type="button" variant="ghost" size="xs" onClick={onReloadConflict}>
                  <RotateCcw data-icon="inline-start" />
                  重新载入
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={onSaveConflictAsNew}>
                  另存为新便签
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
                <RotateCcw data-icon="inline-start" />
                重试
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="复制便签正文"
              onClick={() => void window.desktop.clipboard.writeText(content)}
            >
              <Copy />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <Textarea
        ref={editorRef}
        aria-label="便签正文"
        value={content}
        placeholder="直接写下想法…"
        disabled={status === "loading"}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-0 flex-1 resize-none rounded-none border-0 px-8 py-7 font-mono text-sm leading-7 focus-visible:border-transparent md:text-sm"
      />
    </section>
  )
}

function saveLabel(status: "loading" | NoteSaveStatus, selected: NoteView | undefined): string {
  if (status === "loading") return "正在加载…"
  if (status === "saving") return "保存中…"
  if (status === "saved") return selected?.recovered ? "已恢复并保存" : "已保存"
  if (status === "error") return "保存失败"
  if (status === "conflict") return "保存冲突"
  return selected?.noteId ? "已保存" : "开始输入后自动保存"
}
