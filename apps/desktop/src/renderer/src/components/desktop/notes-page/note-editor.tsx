import { useEffect, useRef } from "react"
import {
  ArrowDownToLine,
  CircleAlert,
  Copy,
  Ellipsis,
  Maximize2,
  Minimize2,
  RotateCcw,
  StickyNote,
  Trash2,
} from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { cn } from "@renderer/lib/utils"
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
  onClose,
  expanded,
  onExpand,
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
  onClose: () => void
  expanded: boolean
  onExpand: () => void
}): React.JSX.Element {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editorRef.current && !editorRef.current.disabled) editorRef.current.focus()
  }, [selected?.draftId])

  return (
    <Card
      aria-label="当前便签"
      className="min-w-0 gap-0 py-0 focus-within:ring-2 focus-within:ring-ring"
    >
      <CardHeader className="flex h-14 flex-row items-center gap-2">
        <StickyNote
          className="size-4 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <CardTitle className="mr-auto">{selected?.noteId ? "继续这一句" : "随手记"}</CardTitle>
        <Button
          variant="ghost"
          shape="circle"
          size="icon-sm"
          aria-label={expanded ? "还原便签大小" : "展开阅读便签"}
          onClick={onExpand}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        {selected && (selected.noteId || content.trim()) ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  shape="circle"
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
        <Button variant="ghost" shape="pill" size="sm" aria-label="收起便签" onClick={onClose}>
          <ArrowDownToLine data-icon="inline-start" />
          收起
        </Button>
      </CardHeader>

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

      <CardContent className="px-0">
        <Textarea
          ref={editorRef}
          aria-label="便签正文"
          value={content}
          placeholder="有什么想法？记一句就好…"
          disabled={status === "loading"}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "max-h-[55vh] min-h-52 resize-none rounded-none border-0 px-6 py-3 text-sm leading-7 font-normal focus-visible:border-transparent md:text-sm",
            expanded && "max-h-[75vh] min-h-[60vh]"
          )}
        />
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {saveLabel(status, selected)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{content.length} 字</span>
      </CardFooter>
    </Card>
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
