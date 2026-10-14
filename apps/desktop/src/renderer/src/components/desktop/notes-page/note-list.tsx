import { CirclePlus, Pin, StickyNote } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { ProjectFolderItem } from "@renderer/components/motion/project-folder"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@renderer/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { cn } from "@renderer/lib/utils"
import { describeNote, type NoteView } from "./note-model"
import { NoteActions } from "./note-actions"
import type { NoteAppearance } from "./note-appearance"
import { notePaperClasses } from "./note-paper"
import { SPRING_LAYOUT } from "@renderer/lib/ease"

const MotionCard = motion.create(Card)

const noteTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

export function NoteList({
  notes,
  selectedKey,
  query,
  loading,
  onSelect,
  onCreate,
  onAppearanceChange,
  onDelete,
  showCreate = false,
}: {
  notes: NoteView[]
  selectedKey: string | null
  query: string
  loading: boolean
  onSelect: (draftId: string) => void
  onCreate: () => void
  onAppearanceChange: (draftId: string, patch: Partial<NoteAppearance>) => void
  onDelete: (draftId: string) => void
  showCreate?: boolean
}): React.JSX.Element {
  const reduced = useReducedMotion()
  return (
    <section aria-label="便签列表" className="min-w-0">
      {loading ? (
        <div className="grid grid-cols-2 gap-4" aria-label="正在加载便签">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </div>
      ) : notes.length === 0 && !showCreate ? (
        <Empty className="border-0 px-0 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <StickyNote />
            </EmptyMedia>
            <EmptyTitle>{query ? "没有匹配的便签" : "这里留给下一句想法"}</EmptyTitle>
            <EmptyDescription>
              {query ? "换个关键词试试。" : "不必起标题，写下就会自动保存。"}
            </EmptyDescription>
          </EmptyHeader>
          {!query ? (
            <Button variant="ghost" shape="pill" onClick={onCreate}>
              记一句
            </Button>
          ) : null}
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-start gap-x-6 gap-y-8 pt-3">
          {showCreate ? (
            <motion.button
              type="button"
              aria-label="新建便签"
              layoutId={reduced ? undefined : "note-create"}
              transition={SPRING_LAYOUT}
              onClick={(event) => {
                event.currentTarget.focus()
                onCreate()
              }}
              className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-foreground/15 text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:bg-foreground/3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CirclePlus className="size-6" strokeWidth={1.75} aria-hidden="true" />
              <span className="text-sm">记一句</span>
            </motion.button>
          ) : null}
          {notes.map((note, index) => {
            const { title, preview } = describeNote(note.content)
            return (
              <ProjectFolderItem key={note.draftId} id={note.draftId} index={index}>
                <MotionCard
                  layoutId={reduced ? undefined : `note-${note.draftId}`}
                  transition={SPRING_LAYOUT}
                  size="sm"
                  data-note-id={note.draftId}
                  data-note-color={note.color ?? "default"}
                  className={cn(
                    "note-paper group/note aspect-square w-full min-w-0 -rotate-1",
                    notePaperClasses
                  )}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 56"
                    className="pointer-events-none absolute -top-3 right-5 z-10 h-10 w-[18px] rotate-[5deg] overflow-visible text-(--note-ink) drop-shadow-[1px_1px_0_rgba(255,255,255,0.45)]"
                    fill="none"
                  >
                    <path
                      d="M17 5.25C17 2.35 14.65 0 11.75 0C7.85 0 5 3.15 5 7.5V43.5C5 47.15 7.85 50 11.25 50C14.65 50 17 47.15 17 43.5V17.25C17 14.65 15.2 12.75 13 12.75C11.2 12.75 9.75 14.1 9.75 16V37.5"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <button
                    type="button"
                    aria-label={"打开便签：" + title}
                    aria-current={note.draftId === selectedKey ? "true" : undefined}
                    onClick={(event) => {
                      event.currentTarget.focus()
                      onSelect(note.draftId)
                    }}
                    className="absolute inset-0 rounded-sm text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-[inherit]">
                    <CardHeader className="pointer-events-none relative pt-6">
                      <CardTitle className="line-clamp-2 break-words">{title}</CardTitle>
                      <div className="pointer-events-none absolute top-0 left-2 opacity-0 transition-opacity group-focus-within/note:pointer-events-auto group-focus-within/note:opacity-100 group-hover/note:pointer-events-auto group-hover/note:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                        <NoteActions
                          note={note}
                          label={"便签操作：" + title}
                          onAppearanceChange={(patch) => onAppearanceChange(note.draftId, patch)}
                          onDelete={() => onDelete(note.draftId)}
                        />
                      </div>
                    </CardHeader>
                    <CardContent className="pointer-events-none relative min-h-0 flex-1 overflow-hidden">
                      <p className="line-clamp-5 text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                        {preview || "只有这一句，也值得记下。"}
                      </p>
                    </CardContent>
                    <CardFooter className="pointer-events-none relative justify-between gap-2 border-0 bg-transparent">
                      <time
                        dateTime={new Date(note.updatedAt).toISOString()}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        {noteTimeFormatter.format(note.updatedAt)}
                      </time>
                      {note.recovered ? <Badge variant="secondary">待恢复</Badge> : null}
                      {note.pinned ? (
                        <Pin
                          className="size-3.5 text-muted-foreground"
                          aria-label="已置顶"
                          strokeWidth={1.75}
                        />
                      ) : null}
                    </CardFooter>
                  </div>
                </MotionCard>
              </ProjectFolderItem>
            )
          })}
        </div>
      )}
    </section>
  )
}
