import { StickyNote } from "lucide-react"
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
}: {
  notes: NoteView[]
  selectedKey: string | null
  query: string
  loading: boolean
  onSelect: (draftId: string) => void
  onCreate: () => void
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
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] items-start gap-4">
          {notes.map((note, index) => {
            const { title, preview } = describeNote(note.content)
            return (
              <ProjectFolderItem key={note.draftId} id={note.draftId} index={index}>
                <button
                  type="button"
                  aria-label={"打开便签：" + title}
                  aria-current={note.draftId === selectedKey ? "true" : undefined}
                  onClick={() => onSelect(note.draftId)}
                  className="group w-full min-w-0 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                >
                  <Card
                    size="sm"
                    className={cn(
                      "transition-colors group-hover:bg-accent",
                      note.draftId === selectedKey && "ring-2 ring-ring"
                    )}
                  >
                    <CardHeader>
                      <CardTitle className="line-clamp-2 break-words">{title}</CardTitle>
                    </CardHeader>
                    <CardContent className="min-h-16">
                      <p className="line-clamp-5 text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                        {preview || "只有这一句，也值得记下。"}
                      </p>
                    </CardContent>
                    <CardFooter className="justify-between gap-2">
                      <time
                        dateTime={new Date(note.updatedAt).toISOString()}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        {noteTimeFormatter.format(note.updatedAt)}
                      </time>
                      {note.recovered ? <Badge variant="secondary">待恢复</Badge> : null}
                    </CardFooter>
                  </Card>
                </button>
              </ProjectFolderItem>
            )
          })}
        </div>
      )}
    </section>
  )
}
