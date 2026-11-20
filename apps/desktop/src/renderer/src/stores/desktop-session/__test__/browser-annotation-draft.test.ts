// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest"
import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import { composerDocument } from "../composer-document"
import { readComposerRecovery, saveComposerRecovery } from "../composer-recovery"
import { useDesktopSessionStore } from "../store"
import { resetDesktopSessionStore } from "../store-test-fixtures"

const record: BrowserAnnotationRecord = {
  id: "annotation-1", pageUrl: "https://example.com/", target: "button: 提交",
  selector: "#submit", locatorKind: "unique-id", tagName: "button", role: "button",
  name: "提交", comment: "增加间距",
}

beforeEach(() => {
  resetDesktopSessionStore()
  localStorage.clear()
})

it("keeps browser comments with their composer when a new conversation becomes a session", async () => {
  const actions = useDesktopSessionStore.getState()
  actions.putBrowserAnnotation("new-conversation", record)
  actions.updateBrowserAnnotationComment("new-conversation", record.id, "增大按钮间距")
  actions.setComposerDraftText("session:other", "另一聊天")
  actions.migrateComposerDraft("new-conversation", "session:created")

  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:created"]?.browserAnnotations)
    .toEqual([{ ...record, comment: "增大按钮间距" }])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:other"]?.browserAnnotations)
    .toBeUndefined()
})

it("removes individual or all pending browser comments without clearing the text", async () => {
  const actions = useDesktopSessionStore.getState()
  actions.setComposerDraftText("session:a", "正文")
  actions.putBrowserAnnotation("session:a", record)
  actions.putBrowserAnnotation("session:a", { ...record, id: "annotation-2" })
  actions.removeBrowserAnnotation("session:a", record.id)
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:a"]?.browserAnnotations)
    .toEqual([{ ...record, id: "annotation-2" }])
  actions.clearBrowserAnnotations("session:a")
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:a"])
    .toMatchObject({ document: composerDocument([{ type: "text", text: "正文" }]), browserAnnotations: [] })
})

it("recovers browser comments even when the composer has no text or files", async () => {
  await saveComposerRecovery({
    composerDraftsByScope: {
      "session:a": { document: composerDocument([]), attachments: [], browserAnnotations: [record] },
    },
    sessionRuntimes: {},
  })
  expect((await readComposerRecovery()).composerDraftsByScope["session:a"]?.browserAnnotations)
    .toEqual([record])
})
