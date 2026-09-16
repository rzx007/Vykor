import { useId, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldGroup } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Label } from "@renderer/components/ui/label"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopSessionRecord } from "@shared/session-types"

export function useSessionActionDialogs(): {
  beginRename: (session: DesktopSessionRecord) => void
  beginArchive: (session: DesktopSessionRecord) => void
  beginDelete: (session: DesktopSessionRecord) => void
  dialogs: React.JSX.Element
} {
  const renameSession = useDesktopSessionStore((state) => state.renameSession)
  const archiveSession = useDesktopSessionStore((state) => state.archiveSession)
  const deleteSession = useDesktopSessionStore((state) => state.deleteSession)
  const renameFieldId = useId()
  const [renameTarget, setRenameTarget] = useState<DesktopSessionRecord | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<DesktopSessionRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DesktopSessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busy, setBusy] = useState(false)

  const beginRename = (session: DesktopSessionRecord): void => {
    const title = session.title.trim()
    setRenameValue(title && title !== "TUI" ? title : "新对话")
    setRenameTarget(session)
  }

  const submitRename = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!renameTarget || !renameValue.trim() || busy) return
    setBusy(true)
    void renameSession(renameTarget.id, renameValue)
      .then(() => setRenameTarget(null))
      .finally(() => setBusy(false))
  }

  const confirmArchive = (): void => {
    if (!archiveTarget || busy) return
    setBusy(true)
    void archiveSession(archiveTarget.id)
      .then(() => setArchiveTarget(null))
      .finally(() => setBusy(false))
  }

  const confirmDelete = (): void => {
    if (!deleteTarget || busy) return
    setBusy(true)
    void deleteSession(deleteTarget.id)
      .then(() => setDeleteTarget(null))
      .finally(() => setBusy(false))
  }

  return {
    beginRename,
    beginArchive: setArchiveTarget,
    beginDelete: setDeleteTarget,
    dialogs: (
      <>
        <Dialog
          open={renameTarget !== null}
          onOpenChange={(value) => !value && setRenameTarget(null)}
        >
          <DialogContent>
            <form onSubmit={submitRename} className="contents">
              <DialogHeader>
                <DialogTitle>重命名会话</DialogTitle>
                <DialogDescription>使用一个便于稍后识别的名称。</DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <Label htmlFor={renameFieldId}>会话名称</Label>
                  <Input
                    id={renameFieldId}
                    name="name"
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    maxLength={80}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">取消</Button>} />
                <Button type="submit" disabled={!renameValue.trim() || busy}>
                  {busy ? "保存中..." : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={archiveTarget !== null}
          onOpenChange={(value) => !value && setArchiveTarget(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>归档会话？</DialogTitle>
              <DialogDescription>
                {archiveTarget?.status === "running"
                  ? "会话仍在运行。归档会先停止当前任务，再将会话移入已归档列表。"
                  : "归档后会话将从项目和最近列表移除，但历史消息仍会保留。"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button variant="destructive" disabled={busy} onClick={confirmArchive}>
                {busy ? "归档中..." : "归档"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(value) => !value && setDeleteTarget(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>永久删除会话？</DialogTitle>
              <DialogDescription>
                删除后会话、消息、运行记录和权限记录都会从本机存储中移除，无法从已归档列表恢复。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button variant="destructive" disabled={busy} onClick={confirmDelete}>
                {busy ? "删除中..." : "永久删除"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    ),
  }
}
