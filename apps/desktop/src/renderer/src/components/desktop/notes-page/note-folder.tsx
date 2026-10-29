import { useEffect, useRef, useState, type ReactNode } from "react"
import { Ellipsis, GripVertical } from "lucide-react"
import { ProjectFolder } from "@renderer/components/motion/project-folder"
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@renderer/components/motion/popover-morph"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { describeNote, type NoteView } from "./note-model"

export function NoteFolder({
  id,
  name,
  notes,
  open,
  dragging,
  readOnly,
  onOpenChange,
  onRename,
  onDissolve,
  children,
  handleProps,
  renameRequested,
  onRenameHandled,
}: {
  id: string
  name: string
  notes: NoteView[]
  open: boolean
  dragging: boolean
  readOnly: boolean
  onOpenChange: (open: boolean) => void
  onRename: (name: string) => Promise<boolean>
  onDissolve: () => void
  children: ReactNode
  handleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>
  renameRequested?: boolean
  onRenameHandled: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renameRequested) {
      setValue(name)
      setRenaming(true)
      onRenameHandled()
    }
  }, [renameRequested, name, onRenameHandled])
  useEffect(() => {
    if (renaming) input.current?.select()
  }, [renaming])
  return (
    <div data-folder-id={id} className="relative min-w-0 pt-6">
      <ProjectFolder
        title={name}
        count={notes.length}
        ariaLabel={`打开文件夹：${name}`}
        className="h-48 w-full"
        expanded={open}
        dragging={dragging}
        inPlace
        boundaryId={id}
        onExpandedChange={onOpenChange}
        expandedContent={children}
        previews={notes.slice(0, 5).map((note) => ({
          id: note.draftId,
          content: (
            <span
              data-note-color={note.color ?? "default"}
              className="note-paper block h-full px-3 py-4 text-xs break-words"
            >
              {describeNote(note.content).title}
            </span>
          ),
        }))}
      />
      <div className="absolute top-0 right-0 flex items-center gap-1">
        <Button
          {...handleProps}
          variant="ghost"
          shape="circle"
          size="icon-sm"
          disabled={readOnly}
          aria-label={`移动文件夹：${name}`}
        >
          <GripVertical />
        </Button>
        <MorphPopover open={menuOpen} onOpenChange={setMenuOpen}>
          <MorphPopoverTrigger>
            <Button
              variant="ghost"
              shape="circle"
              size="icon-sm"
              aria-label={`文件夹操作：${name}`}
              disabled={readOnly}
            >
              <Ellipsis />
            </Button>
          </MorphPopoverTrigger>
          <MorphPopoverContent align="end">
            <div className="flex flex-col gap-1 p-2">
              <Button
                variant="ghost"
                shape="pill"
                onClick={() => {
                  setMenuOpen(false)
                  setValue(name)
                  setRenaming(true)
                }}
              >
                重命名
              </Button>
              <Button
                variant="ghost"
                shape="pill"
                onClick={() => {
                  setMenuOpen(false)
                  onDissolve()
                }}
              >
                解散文件夹
              </Button>
            </div>
          </MorphPopoverContent>
        </MorphPopover>
      </div>
      {renaming ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void onRename(value).then((saved) => {
              if (saved) setRenaming(false)
            })
          }}
        >
          <Input
            ref={input}
            aria-label="文件夹名称"
            value={value}
            disabled={readOnly}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation()
                setRenaming(false)
              }
            }}
          />
          <Button variant="ghost" size="sm" shape="pill" disabled={readOnly} type="submit">
            保存
          </Button>
          <Button variant="ghost" size="sm" shape="pill" onClick={() => setRenaming(false)}>
            取消
          </Button>
        </form>
      ) : null}
    </div>
  )
}
