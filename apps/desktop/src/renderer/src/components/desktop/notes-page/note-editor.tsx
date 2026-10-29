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
import { notePaperClasses } from "./note-paper"

// 卡片与详情共用布局标识，展开时保留同一张纸的比例。
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
  layoutId,
  pinDisabled,
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
  layoutId?: string
  pinDisabled?: boolean
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
      layoutId={reduced ? undefined : layoutId}
      layoutDependency={`${selected?.draftId ?? "draft"}:${expanded}:${Boolean(error)}`}
      transition={transition}
      data-note-color={selected?.color ?? "default"}
      className={cn("note-paper aspect-square w-full min-w-0 gap-0 py-0", notePaperClasses)}
    >
      {/* 裁切层随纸面一起缩放，内部文字的位置动画不能越过纸张边缘。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <motion.div
          layout={reduced ? false : "position"}
          transition={transition}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CardHeader className="flex h-14 shrink-0 flex-row items-center gap-2">
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
                pinDisabled={pinDisabled}
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
            <Alert
              variant="destructive"
              className="mx-5 mt-4 max-h-[35%] w-auto shrink-0 overflow-y-auto"
            >
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

          <CardContent className="flex min-h-0 flex-1 flex-col px-0">
            <Textarea
              ref={editorRef}
              aria-label="便签正文"
              value={content}
              placeholder="有什么想法？记一句就好…"
              disabled={status === "loading"}
              onChange={(event) => onChange(event.target.value)}
              className="field-sizing-fixed h-full min-h-0 flex-1 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-6 py-3 text-sm leading-7 font-normal focus-visible:border-transparent focus-visible:ring-0 md:text-sm dark:bg-transparent"
            />
          </CardContent>
          <CardFooter className="shrink-0 justify-between gap-3 border-0 bg-transparent">
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {saveLabel(status, selected)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{content.length} 字</span>
          </CardFooter>
        </motion.div>
      </div>
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
