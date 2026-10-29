import { useId, useRef, useState } from "react"
import { LayoutGroup } from "motion/react"
import { CircleAlert, CirclePlus, FolderOpen, Search } from "lucide-react"
import { moveNoteToDesktop } from "@rzx/client"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { toast } from "@renderer/lib/toast"
import { NoteDeleteDialog } from "./note-delete-dialog"
import { NoteDetail } from "./note-detail"
import { NoteBoard } from "./note-board"
import type { NoteAppearance } from "./note-appearance"
import { useNotesController } from "./use-notes-controller"
import { useNoteOrganization } from "./use-note-organization"

export function NotesPage(): React.JSX.Element {
  const notes = useNotesController()
  const organization = useNoteOrganization(notes.notes)
  const layoutGroupId = useId()
  const returnFocus = useRef<HTMLElement | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailSource, setDetailSource] = useState<string | undefined>()
  const [expanded, setExpanded] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const selected = notes.notes.find((note) => note.draftId === notes.selectedKey)
  const papers = notes.notes.filter((note) => note.noteId || note.content.trim())

  const prepareDetail = (source: string): void => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDetailSource(source)
    setExpanded(false)
  }
  const createNote = (): void => {
    prepareDetail("note-create")
    notes.createDraft()
    setDetailOpen(true)
  }
  const selectNote = async (draftId: string): Promise<void> => {
    prepareDetail(`note-${draftId}`)
    await notes.select(draftId)
    setDetailOpen(true)
  }
  const closeDetail = (): void => {
    setDetailOpen(false)
    void notes.flushSelected()
  }
  const changeAppearance = (draftId: string, patch: Partial<NoteAppearance>): void => {
    const note = notes.notes.find((item) => item.draftId === draftId)
    if (!note) return
    if (patch.pinned === undefined || !note.noteId) {
      notes.setAppearance(draftId, patch)
      return
    }
    if (organization.readOnly) return
    const before = { pinned: Boolean(note.pinned) }
    void organization.change(
      (value) => {
        let next = value
        if (
          patch.pinned &&
          !value.desktop.some((item) => item.type === "note" && item.id === note.noteId)
        ) {
          next = moveNoteToDesktop(value, { noteId: note.noteId!, desktopIndex: 0 })
        }
        const pinnedIds = new Set(
          notes.notes
            .filter((item) => (item.draftId === draftId ? patch.pinned : item.pinned))
            .map((item) => item.noteId)
        )
        return {
          ...next,
          desktop: [
            ...next.desktop.filter((item) => item.type === "note" && pinnedIds.has(item.id)),
            ...next.desktop.filter((item) => item.type !== "note" || !pinnedIds.has(item.id)),
          ],
        }
      },
      () => notes.setAppearance(draftId, before),
      () => notes.setAppearance(draftId, patch)
    )
  }
  const error = [notes.error, organization.error].filter(Boolean).join("；")

  return (
    <LayoutGroup id={layoutGroupId}>
      <section className="@container/notes flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-5 py-2 @3xl/notes:px-8">
          <h1 className="mr-2 text-lg font-semibold tracking-tight">便签</h1>
          <div className="ml-auto w-40 flex-1 @3xl/notes:max-w-64">
            <InputGroup shape="pill">
              <InputGroupAddon>
                <Search strokeWidth={1.75} />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="搜索便签"
                placeholder="找回一句想法…"
                value={notes.query}
                onChange={(event) => notes.setQuery(event.target.value)}
              />
            </InputGroup>
          </div>
          <Button
            shape="pill"
            aria-label="新建便签"
            disabled={notes.status === "loading"}
            onClick={(event) => {
              event.currentTarget.focus()
              createNote()
            }}
          >
            <CirclePlus data-icon="inline-start" />
            记一句
          </Button>
        </header>
        <ScrollArea
          horizontal={false}
          aria-label="滚动查看便签"
          className="min-h-0 flex-1"
          viewportClassName="h-full"
        >
          <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-8 @3xl/notes:px-8 @3xl/notes:py-10">
            {error ? (
              <Alert variant="destructive" className="mb-6">
                <CircleAlert />
                <AlertTitle>
                  {notes.status === "conflict" ? "便签内容发生冲突" : "保存失败"}
                </AlertTitle>
                <AlertDescription>{error}</AlertDescription>
                <AlertAction>
                  {organization.error ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      shape="pill"
                      onClick={() => void organization.retry()}
                    >
                      重试整理
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      shape="pill"
                      onClick={() => {
                        if (selected) void selectNote(selected.draftId)
                      }}
                    >
                      返回便签处理
                    </Button>
                  )}
                </AlertAction>
              </Alert>
            ) : null}
            {organization.warning ? (
              <Alert className="mb-6">
                <CircleAlert />
                <AlertTitle>便签分类提醒</AlertTitle>
                <AlertDescription>{organization.warning}</AlertDescription>
                <AlertAction>
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="pill"
                    onClick={() =>
                      void window.desktop.notes
                        .openDirectory()
                        .catch((cause) => toast.error("无法打开便签文件夹", String(cause)))
                    }
                  >
                    查看分类和恢复文件
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            <NoteBoard
              notes={papers}
              organization={organization}
              query={notes.query}
              loading={notes.status === "loading"}
              selectedKey={detailOpen ? notes.selectedKey : null}
              onCreate={createNote}
              onSelect={(id) => void selectNote(id)}
              onAppearanceChange={changeAppearance}
              onDelete={(id) => {
                setDeleteTarget(id)
                setDeleteOpen(true)
              }}
            />
            <footer className="mt-auto flex items-center justify-between gap-4 pt-10 text-xs text-muted-foreground">
              <span>
                {organization.saving
                  ? "正在保存整理…"
                  : papers.length
                    ? `${papers.length} 句想法，留在这里。`
                    : "从一句话开始。"}
              </span>
              <Button
                size="xs"
                variant="ghost"
                shape="pill"
                onClick={() =>
                  void window.desktop.notes
                    .openDirectory()
                    .catch((cause) => toast.error("无法打开便签文件夹", String(cause)))
                }
              >
                <FolderOpen data-icon="inline-start" />
                打开便签文件夹
              </Button>
            </footer>
          </div>
        </ScrollArea>
        <NoteDetail
          pinDisabled={organization.readOnly}
          open={detailOpen}
          returnFocus={returnFocus}
          layoutId={detailSource}
          selected={selected}
          content={notes.content}
          status={notes.status}
          error={notes.error}
          expanded={expanded}
          onExpand={() => setExpanded((current) => !current)}
          onClose={closeDetail}
          onExitComplete={() => {
            if (notes.selectedKey) notes.discardEmptyDraft(notes.selectedKey)
          }}
          onChange={notes.edit}
          onAppearanceChange={(patch) => {
            if (notes.selectedKey) changeAppearance(notes.selectedKey, patch)
          }}
          onRetry={() => void notes.retrySave()}
          onReloadConflict={() => void notes.reloadConflict()}
          onSaveConflictAsNew={() => void notes.saveConflictAsNew()}
          onDelete={() => {
            setDeleteTarget(notes.selectedKey)
            setDeleteOpen(true)
          }}
        />
        <NoteDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => {
            setDeleteOpen(false)
            if (deleteTarget)
              void notes.removeSelected(deleteTarget).then(() => {
                if (deleteTarget === notes.selectedKey) setDetailOpen(false)
              })
          }}
        />
      </section>
    </LayoutGroup>
  )
}
