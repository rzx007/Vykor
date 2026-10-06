import { useEffect, useRef } from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowDownToLine,
  CircleAlert,
  Copy,
  Maximize2,
  Minimize2,
  RotateCcw,
  StickyNote,
  Pin,
} from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { cn } from "@renderer/lib/utils"
import { SPRING_LAYOUT } from "@renderer/lib/ease"
import { NoteActions } from "./note-actions"
import type { NoteAppearance } from "./note-appearance"
import { Textarea } from "@renderer/components/ui/textarea"
import type { NoteView } from "./note-model"
import type { NoteSaveStatus } from "./note-save-coordinator"

// 使用 beUI morphing-modal 相同的布局方式，但不创建弹窗或替换输入框。
const MotionCard = motion.create(Card)

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
  onAppearanceChange,
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
  onAppearanceChange?: (patch: Partial<NoteAppearance>) => void
}): React.JSX.Element {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const reduced = useReducedMotion()
  const transition = reduced ? { duration: 0 } : SPRING_LAYOUT

  useEffect(() => {
    if (editorRef.current && !editorRef.current.disabled) editorRef.current.focus()
  }, [selected?.draftId])

  return (
    <MotionCard
      aria-label="当前便签"
      layout={!reduced}
      layoutDependency={`${selected?.draftId ?? "draft"}:${expanded}:${Boolean(error)}`}
      transition={transition}
      data-note-color={selected?.color ?? "default"}
      className="note-paper min-w-0 gap-0 py-0 focus-within:ring-2 focus-within:ring-ring"
    >
      <motion.div layout={reduced ? false : "position"} transition={transition}>
        <CardHeader className="flex h-14 flex-row items-center gap-2">
          <StickyNote
            className="size-4 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <CardTitle className="mr-auto">{selected?.noteId ? "继续这一句" : "随手记"}</CardTitle>
          {selected?.pinned ? (
            <Pin
              className="size-3.5 text-muted-foreground"
              aria-label="已置顶"
              strokeWidth={1.75}
            />
          ) : null}
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
            <NoteActions
              note={{ ...selected, content }}
              onAppearanceChange={onAppearanceChange}
              onDelete={onDelete}
            />
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
              "max-h-[55vh] min-h-32 resize-none rounded-none border-0 bg-transparent px-6 py-3 text-sm leading-7 font-normal focus-visible:border-transparent md:text-sm dark:bg-transparent",
              expanded && "max-h-[75vh] min-h-[60vh]"
            )}
          />
        </CardContent>
        <CardFooter className="justify-between gap-3 border-0 bg-transparent">
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {saveLabel(status, selected)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{content.length} 字</span>
        </CardFooter>
      </motion.div>
    </MotionCard>
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
