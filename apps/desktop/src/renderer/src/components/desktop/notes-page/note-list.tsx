import { Plus, Search, StickyNote } from "lucide-react"

import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@renderer/components/ui/item"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
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
  onQueryChange,
  onCreate,
  onSelect,
}: {
  notes: NoteView[]
  selectedKey: string | null
  query: string
  loading: boolean
  onQueryChange: (value: string) => void
  onCreate: () => void
  onSelect: (draftId: string) => void
}): React.JSX.Element {
  return (
    <aside
      aria-label="便签列表"
      className="flex min-h-0 min-w-0 flex-col border-r border-border/70 bg-muted/20"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <h1 className="text-lg font-semibold tracking-tight">便签</h1>
        <Badge variant="secondary">全部项目共用</Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="新建便签"
          title="新建便签"
          onClick={onCreate}
        >
          <Plus />
        </Button>
      </header>

      <div className="shrink-0 px-3 pb-3">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="搜索便签"
            placeholder="搜索正文"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </InputGroup>
      </div>

      <ScrollArea horizontal={false} className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
        {loading ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">正在加载便签…</p>
        ) : notes.length === 0 ? (
          <Empty className="min-h-52 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <StickyNote />
              </EmptyMedia>
              <EmptyTitle>{query ? "没有匹配的便签" : "还没有便签"}</EmptyTitle>
              <EmptyDescription>
                {query ? "换个关键词试试。" : "直接在右侧输入，第一行会成为列表标题。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1">
            {notes.map((note) => {
              const description = describeNote(note.content)
              return (
                <Item
                  key={note.draftId}
                  size="xs"
                  variant="default"
                  render={
                    <button
                      type="button"
                      aria-current={note.draftId === selectedKey ? "page" : undefined}
                      onClick={() => onSelect(note.draftId)}
                    />
                  }
                  className={cn(
                    "items-start text-left",
                    note.draftId === selectedKey && "bg-muted"
                  )}
                >
                  <ItemContent className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <ItemTitle className="min-w-0 flex-1 truncate">{description.title}</ItemTitle>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {noteTimeFormatter.format(note.updatedAt)}
                      </span>
                    </div>
                    {description.preview ? (
                      <ItemDescription className="line-clamp-1">
                        {description.preview}
                      </ItemDescription>
                    ) : null}
                    {note.recovered ? (
                      <span className="text-[10px] text-muted-foreground">待恢复</span>
                    ) : null}
                  </ItemContent>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      </ScrollArea>
    </aside>
  )
}
