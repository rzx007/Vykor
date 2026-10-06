import { Pin, StickyNote } from "lucide-react"
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
}: {
  notes: NoteView[]
  selectedKey: string | null
  query: string
  loading: boolean
  onSelect: (draftId: string) => void
  onCreate: () => void
  onAppearanceChange: (draftId: string, patch: Partial<NoteAppearance>) => void
  onDelete: (draftId: string) => void
}): React.JSX.Element {
  return (
    <section aria-label="便签列表" className="min-w-0">
      {loading ? (
        <div className="grid grid-cols-2 gap-4" aria-label="正在加载便签">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </div>
      ) : notes.length === 0 ? (
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] items-start gap-4">
          {notes.map((note, index) => {
            const { title, preview } = describeNote(note.content)
            return (
              <ProjectFolderItem key={note.draftId} id={note.draftId} index={index}>
                <Card
                  size="sm"
                  data-note-id={note.draftId}
                  data-note-color={note.color ?? "default"}
                  className={cn(
                    "note-paper group relative aspect-[3/4] w-full min-w-0",
                    note.draftId === selectedKey && "ring-2 ring-ring"
                  )}
                >
                  <button
                    type="button"
                    aria-label={"打开便签：" + title}
                    aria-current={note.draftId === selectedKey ? "true" : undefined}
                    onClick={() => onSelect(note.draftId)}
                    className="absolute inset-0 rounded-xl text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                  <CardHeader className="pointer-events-none relative">
                    <CardTitle className="line-clamp-2 pr-8 break-words">{title}</CardTitle>
                    <div className="pointer-events-auto absolute top-0 right-2">
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
                </Card>
              </ProjectFolderItem>
            )
          })}
        </div>
      )}
    </section>
  )
}
