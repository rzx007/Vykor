import { useCallback, useId, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"

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
import { Spinner } from "@renderer/components/ui/spinner"
import { toast } from "@renderer/lib/toast"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type { DesktopSessionRecord } from "@shared/session-types"

export function useSessionActionDialogs(): {
  beginRename: (session: DesktopSessionRecord) => void
  beginArchive: (session: DesktopSessionRecord) => void
  beginDelete: (session: DesktopSessionRecord) => void
  beginFork: (session: DesktopSessionRecord, afterMessageId?: string) => void
  dialogs: React.JSX.Element
} {
  const renameSession = useDesktopSessionStore((state) => state.renameSession)
  const archiveSession = useDesktopSessionStore((state) => state.archiveSession)
  const deleteSession = useDesktopSessionStore((state) => state.deleteSession)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)
  const navigate = useNavigate()
  const [forkTarget, setForkTarget] = useState<{
    session: DesktopSessionRecord
    afterMessageId?: string
  } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const forkInFlight = useRef(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const renameFieldId = useId()
  const [renameTarget, setRenameTarget] = useState<DesktopSessionRecord | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<DesktopSessionRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DesktopSessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busy, setBusy] = useState(false)

  const beginFork = useCallback((session: DesktopSessionRecord, afterMessageId?: string): void => {
    if (forkInFlight.current) return
    setForkError(null)
    setForkTarget({ session, afterMessageId })
  }, [])

  const confirmFork = async (): Promise<void> => {
    if (!forkTarget || forkInFlight.current) return
    forkInFlight.current = true
    setForkBusy(true)
    setForkError(null)
    let forked: DesktopSessionRecord
    try {
      forked = await forkSession(
        forkTarget.session.id,
        forkTarget.afterMessageId ? { afterMessageId: forkTarget.afterMessageId } : undefined
      )
    } catch {
      setForkError("创建分支失败，请重试。")
      return
    } finally {
      forkInFlight.current = false
      setForkBusy(false)
    }
    setForkTarget(null)
    toast.success("已创建会话分支")
    // 创建已成功；导航失败只能提示打开失败，不能引导再次创建。
    if (useDesktopSessionStore.getState().activeSessionId === forked.id) {
      void navigate({ to: "/conversation/$sessionId", params: { sessionId: forked.id } }).catch(
        () => {
          toast.error("分支已创建，打开失败", "请从侧栏打开新分支。")
        }
      )
    }
  }

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
    beginFork,
    beginArchive: setArchiveTarget,
    beginDelete: setDeleteTarget,
    dialogs: (
      <>
        <Dialog
          open={forkTarget !== null}
          onOpenChange={(value) => {
            if (!value && !forkInFlight.current) {
              setForkTarget(null)
              setForkError(null)
            }
          }}
        >
          <DialogContent showCloseButton={!forkBusy}>
            <DialogHeader>
              <DialogTitle>
                {forkTarget?.afterMessageId ? "从这条回复创建分支？" : "创建会话分支？"}
              </DialogTitle>
              <DialogDescription className="wrap-anywhere">
                {forkTarget?.session.title.trim() || "新对话"}：
                {forkTarget?.afterMessageId
                  ? "保留截至这条回复的历史，后续可独立继续。"
                  : "保留当前历史，后续可独立继续。"}
              </DialogDescription>
            </DialogHeader>
            {forkError ? (
              <p role="alert" className="text-sm text-destructive">
                {forkError}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose
                render={
                  <Button variant="outline" shape="pill" disabled={forkBusy}>
                    取消
                  </Button>
                }
              />
              <Button
                shape="pill"
                disabled={forkBusy}
                aria-busy={forkBusy || undefined}
                onClick={() => void confirmFork()}
              >
                {forkBusy ? <Spinner data-icon="inline-start" /> : null}
                {forkBusy ? "正在创建…" : "创建分支"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
