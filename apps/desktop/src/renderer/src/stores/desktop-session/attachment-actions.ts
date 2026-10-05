import type {
  DesktopAttachmentCandidate,
  DesktopAttachmentError,
  DesktopAttachmentUploadEvent,
  UploadDesktopAttachmentMemoryInput,
} from "@shared/attachment-types"

import {
  addCandidates,
  applyUploadEvent,
  beginUpload,
  findUploadEventScope,
  migrateComposerScope,
  removeDraftAttachment,
  resetComposerScope,
  selectDraftAttachments,
  selectDraftDocument,
  setDraftDocument,
  setDraftText,
} from "./composer-draft-state"
import type { AttachmentActions, DesktopStoreContext } from "./types"
import { composerDocument, type ComposerDocument } from "./composer-document"

export function createAttachmentActions(context: DesktopStoreContext): AttachmentActions {
  const { get, set } = context

  const startCandidates = async (
    scope: string,
    candidates: readonly DesktopAttachmentCandidate[]
  ): Promise<void> => {
    set((state) => addCandidates(state, scope, candidates))
    await Promise.all(
      candidates.map(async (candidate) => {
        const taskId = crypto.randomUUID()
        set((state) => beginUpload(state, scope, candidate.draftId, taskId))
        try {
          await window.desktop.attachments.startUpload({
            draftId: candidate.draftId,
            taskId,
            sourceToken: candidate.sourceToken,
          })
        } catch {
          set((state) =>
            applyUploadEvent(state, scope, {
              type: "failed",
              draftId: candidate.draftId,
              taskId,
              error: actionError(),
            })
          )
        }
      })
    )
  }

  return {
    async addImageFeedback(scope, input) {
      const support = get().attachmentSupport
      if (!support?.interactionEnabled) throw new Error("当前聊天暂不支持图片附件")
      if (!input.text.trim()) throw new Error("请先填写批注意见")
      const hasOriginal =
        input.originalAssetId &&
        selectDraftAttachments(get(), scope).some((a) => a.assetId === input.originalAssetId)
      const uploads = hasOriginal ? [input.marked] : [input.original, input.marked]
      const existing = selectDraftAttachments(get(), scope)
      if (
        support.limits &&
        (existing.length + uploads.length > support.limits.maxFilesPerPrompt ||
          uploads.some((file) => file.bytes.byteLength > support.limits!.maxBytesPerFile) ||
          existing.reduce((sum, a) => sum + a.sizeBytes, 0) +
            uploads.reduce((sum, file) => sum + file.bytes.byteLength, 0) >
            support.limits.maxBytesPerPrompt)
      ) {
        throw new Error("图片批注超过当前聊天的附件数量或大小限制")
      }
      set((state) =>
        setDraftDocument(
          state,
          scope,
          composerDocument([
            ...selectDraftDocument(state, scope).items,
            {
              type: "text",
              text: (selectDraftDocument(state, scope).items.length ? "\n\n" : "") + input.text,
            },
          ])
        )
      )
      // 在首次 await 前添加全部候选，已有的草稿迁移和上传事件路由负责后续结果。
      await Promise.all(uploads.map((file) => get().addClipboardAttachment(scope, file)))
    },
    setComposerDraftText(scope, text) {
      set((state) => setDraftText(state, scope, text))
    },

    setComposerDraftDocument(scope: string, document: ComposerDocument) {
      set((state) => setDraftDocument(state, scope, document))
    },

    async pickAttachmentFiles(scope) {
      if (!get().attachmentSupport?.interactionEnabled) return
      await startCandidates(scope, await window.desktop.attachments.pickFiles())
    },

    async pickAttachmentImages(scope) {
      if (!get().attachmentSupport?.interactionEnabled) return
      await startCandidates(scope, await window.desktop.attachments.pickImages())
    },

    async addDroppedAttachments(scope, files) {
      if (!get().attachmentSupport?.interactionEnabled || files.length === 0) return
      await startCandidates(scope, await window.desktop.attachments.stageDroppedFiles(files))
    },

    async addClipboardAttachment(scope, input) {
      if (!get().attachmentSupport?.interactionEnabled) return
      const draftId = crypto.randomUUID()
      const taskId = crypto.randomUUID()
      const candidate: DesktopAttachmentCandidate = {
        draftId,
        sourceToken: "",
        displayName: input.displayName,
        declaredMediaType: input.mediaType,
        sizeBytes: input.bytes.byteLength,
      }
      set((state) => beginUpload(addCandidates(state, scope, [candidate]), scope, draftId, taskId))
      const uploadInput: UploadDesktopAttachmentMemoryInput = { ...input, draftId, taskId }
      try {
        await window.desktop.attachments.uploadClipboardImage(uploadInput)
      } catch {
        set((state) =>
          applyUploadEvent(state, scope, {
            type: "failed",
            draftId,
            taskId,
            error: actionError(),
          })
        )
      }
    },

    async cancelAttachment(scope, draftId) {
      const attachment = selectDraftAttachments(get(), scope).find(
        (item) => item.draftId === draftId
      )
      if (!attachment || attachment.status !== "uploading") return
      await window.desktop.attachments.cancelUpload({ taskId: attachment.taskId })
      set((state) =>
        applyUploadEvent(state, scope, {
          type: "cancelled",
          draftId,
          taskId: attachment.taskId,
        })
      )
    },

    async retryAttachment(scope, draftId) {
      const attachment = selectDraftAttachments(get(), scope).find(
        (item) => item.draftId === draftId
      )
      if (!attachment || attachment.status !== "failed" || !attachment.error?.retryable) return
      const taskId = crypto.randomUUID()
      set((state) => beginUpload(state, scope, draftId, taskId))
      try {
        await window.desktop.attachments.retryUpload({ draftId, taskId })
      } catch {
        set((state) =>
          applyUploadEvent(state, scope, {
            type: "failed",
            draftId,
            taskId,
            error: actionError(),
          })
        )
      }
    },

    async removeAttachment(scope, draftId) {
      const attachment = selectDraftAttachments(get(), scope).find(
        (item) => item.draftId === draftId
      )
      if (!attachment) return
      set((state) => removeDraftAttachment(state, scope, draftId))
      try {
        if (attachment.status === "uploading") {
          await window.desktop.attachments.cancelUpload({ taskId: attachment.taskId })
        } else if (attachment.status === "ready" && attachment.assetId) {
          await window.desktop.attachments.deleteUnreferenced({ assetId: attachment.assetId })
        } else {
          await window.desktop.attachments.discardDraft({ draftId })
        }
      } catch {
        // 清理失败不恢复卡片；daemon 的附件 GC 会兜底。
      }
    },

    migrateComposerDraft(fromScope, toScope) {
      set((state) => migrateComposerScope(state, fromScope, toScope))
    },

    resetComposerDraft(scope) {
      set((state) => resetComposerScope(state, scope))
    },

    applyAttachmentUploadEvent(event: DesktopAttachmentUploadEvent) {
      set((state) => {
        const scope = findUploadEventScope(state, event.draftId, event.taskId)
        return scope ? applyUploadEvent(state, scope, event) : state
      })
    },
  }
}

function actionError(): DesktopAttachmentError {
  return {
    code: "attachment_action_failed",
    message: "附件操作失败，请重试。",
    retryable: true,
  }
}
