import { VykorApiError } from "@vykor/client"
import type {
  CreateDesktopNoteInput,
  DesktopNote,
  UpdateDesktopNoteInput,
} from "@shared/note-types"

import type { NoteRecoveryDraft, NoteRecoveryPort } from "./note-recovery"

export type NoteSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict"

export interface NoteSaveSnapshot {
  status: NoteSaveStatus
  record: DesktopNote | null
  error: string | null
}

interface NoteWriteApi {
  create(input: CreateDesktopNoteInput): Promise<DesktopNote>
  update(id: string, input: UpdateDesktopNoteInput): Promise<DesktopNote>
}

export class NoteSaveCoordinator {
  private record: DesktopNote | null
  private pending: NoteRecoveryDraft | null = null
  private savedContent: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<DesktopNote | null> | null = null
  private state: NoteSaveSnapshot

  constructor(
    private readonly options: {
      api: NoteWriteApi
      recovery: NoteRecoveryPort
      delayMs?: number
      record?: DesktopNote
      onChange?: (snapshot: NoteSaveSnapshot) => void
    }
  ) {
    this.record = options.record ?? null
    this.savedContent = this.record?.content ?? ""
    this.state = {
      status: this.record ? "saved" : "idle",
      record: this.record,
      error: null,
    }
  }

  snapshot(): NoteSaveSnapshot {
    return this.state
  }

  stage(draft: NoteRecoveryDraft): void {
    if (!this.record && !draft.noteId && !draft.content.trim() && !this.running) {
      this.pending = null
      this.options.recovery.remove(draft.draftId)
      this.setState("idle", null)
      return
    }
    this.pending = draft
    this.options.recovery.write(draft)
    if (
      !this.running &&
      this.record &&
      draft.noteId === this.record.id &&
      draft.baseRevision !== this.record.revision &&
      draft.content !== this.savedContent
    ) {
      this.setState(
        "conflict",
        "文件已在其他位置更新。本地未保存内容已保留，可重新载入或另存为新便签。"
      )
      return
    }
    if (this.state.status === "conflict") return
    this.schedule()
  }

  async flush(): Promise<DesktopNote | null> {
    this.clearTimer()
    if (this.running) return await this.running
    if (this.state.status === "error" || this.state.status === "conflict") return this.record
    this.running = this.drain().finally(() => {
      this.running = null
    })
    return await this.running
  }

  async retry(): Promise<DesktopNote | null> {
    if (this.state.status !== "error") return this.record
    this.setState("idle", null)
    return await this.flush()
  }

  dispose(): void {
    this.clearTimer()
  }

  private schedule(): void {
    this.clearTimer()
    this.timer = setTimeout(() => void this.flush(), this.options.delayMs ?? 300)
  }

  private async drain(): Promise<DesktopNote | null> {
    while (this.pending && this.pending.content !== this.savedContent) {
      const target = this.pending
      this.pending = null
      this.setState("saving", null)
      try {
        const noteId = this.record?.id ?? target.noteId
        const saved = noteId
          ? await this.options.api.update(noteId, {
              content: target.content,
              expectedRevision: this.record?.revision ?? target.baseRevision!,
            })
          : await this.options.api.create({ content: target.content })
        this.record = saved
        this.savedContent = target.content
        const pendingAfterSave = this.currentPending()
        if (pendingAfterSave?.content === this.savedContent) {
          this.pending = null
          this.options.recovery.remove(target.draftId)
        } else if (pendingAfterSave) {
          const nextPending = {
            ...pendingAfterSave,
            noteId: saved.id,
            baseRevision: saved.revision,
          }
          this.pending = nextPending
          this.options.recovery.write(nextPending)
        } else {
          this.options.recovery.remove(target.draftId)
        }
      } catch (error) {
        this.pending ??= target
        const message = error instanceof Error ? error.message : String(error)
        this.setState(
          (error instanceof VykorApiError && error.status === 409) ||
            message.includes("Note revision conflict:")
            ? "conflict"
            : "error",
          message
        )
        return this.record
      }
    }
    if (this.pending) {
      this.options.recovery.remove(this.pending.draftId)
      this.pending = null
    }
    this.setState(this.record ? "saved" : "idle", null)
    return this.record
  }

  private setState(status: NoteSaveStatus, error: string | null): void {
    this.state = { status, record: this.record, error }
    this.options.onChange?.(this.state)
  }

  private currentPending(): NoteRecoveryDraft | null {
    return this.pending
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
