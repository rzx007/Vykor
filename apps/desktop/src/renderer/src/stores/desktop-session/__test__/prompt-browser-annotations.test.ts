import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BrowserAnnotationRecord } from "@shared/browser-annotation"
import type { EditLatestDesktopPromptInput, SendDesktopPromptInput } from "@shared/session-types"
import { formatBrowserAnnotationContext } from "@renderer/components/desktop/tools/browser/browser-annotation-context"
import { readComposerRecovery } from "../composer-recovery"
import { composerDocument } from "../composer-document"
import { emptySessionView, resetDesktopSessionStore } from "../store-test-fixtures"
import { useDesktopSessionStore } from "../store"

const annotation: BrowserAnnotationRecord = {
  id: "a-1", pageUrl: "http://127.0.0.1:52849/", target: "section: 流", selector: "#flow",
  comment: "以水墨泼溅展现内容", locatorKind: "unique-id", tagName: "section", role: "region", name: "流",
}

function draft(records: BrowserAnnotationRecord[], scope = "session:chat", text = "按批注改进"): void {
  useDesktopSessionStore.setState(state => ({ composerDraftsByScope: {
    ...state.composerDraftsByScope,
    [scope]: { document: composerDocument([{ type: "text", text }]), attachments: [], browserAnnotations: records },
  } }))
}

function textOf(input: Pick<SendDesktopPromptInput, "items">): string {
  return input.items.filter(item => item.type === "text").map(item => item.text).join("")
}

beforeEach(() => {
  resetDesktopSessionStore()
  localStorage.clear()
  useDesktopSessionStore.setState({ activeSessionId: "chat", sessionView: emptySessionView("chat") })
})
afterEach(() => vi.unstubAllGlobals())

it("sends the visible draft package without reading the page and clears it after success", async () => {
  draft([annotation])
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
  } } })
  const document = useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.document
  await useDesktopSessionStore.getState().sendMessage("按批注改进", { document })
  expect(received).toHaveLength(1)
  expect(textOf(received[0]!)).toContain(annotation.comment)
  expect(textOf(received[0]!)).toContain(annotation.selector)
  expect(textOf(received[0]!)).toContain(annotation.pageUrl)
  expect(document.items).toEqual([{ type: "text", text: "按批注改进" }])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([])
})

it("allows a package to be sent without body text", async () => {
  draft([annotation], "session:chat", "")
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
  } } })
  await useDesktopSessionStore.getState().sendMessage("")
  expect(received).toHaveLength(1)
  expect(textOf(received[0]!)).toContain(annotation.comment)
})

it("does not include a package removed from the draft or belonging to another chat", async () => {
  draft([], "session:chat")
  draft([annotation], "session:other")
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
  } } })
  await useDesktopSessionStore.getState().sendMessage("普通消息")
  expect(received[0]!.items).toEqual([{ type: "text", text: "普通消息" }])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:other"]!.browserAnnotations).toEqual([annotation])
})

it("restores and retries the original package while preserving newer draft edits", async () => {
  draft([annotation])
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    checkPromptAccepted: async () => false,
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input); if (received.length === 1) throw new Error("offline") },
  } } })
  await expect(useDesktopSessionStore.getState().sendMessage("按批注改进")).rejects.toThrow("offline")
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([annotation])
  const restored = readComposerRecovery()
  expect(restored.composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([annotation])
  useDesktopSessionStore.setState({ sessionRuntimes: restored.sessionRuntimes })
  const edited = { ...annotation, comment: "新版批注意见" }
  draft([edited])
  await useDesktopSessionStore.getState().retryPromptSubmission(received[0]!.id, "chat")
  expect(received[1]).toEqual(received[0])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([edited])
})

it("clears only the sent records when more annotations are added during submission", async () => {
  draft([annotation])
  let release!: () => void
  vi.stubGlobal("window", { desktop: { sessions: {
    sendPrompt: () => new Promise<void>(resolve => { release = resolve }),
  } } })
  const request = useDesktopSessionStore.getState().sendMessage("按批注改进")
  const added = { ...annotation, id: "a-2", comment: "新的意见" }
  draft([annotation, added])
  release()
  await request
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([added])
})

it("uses a new input for the same words after the accepted package changes", async () => {
  draft([annotation])
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
  } } })
  await useDesktopSessionStore.getState().sendMessage("按批注改进")
  draft([{ ...annotation, comment: "新增水墨过渡效果" }])
  await useDesktopSessionStore.getState().sendMessage("按批注改进")
  expect(received).toHaveLength(2)
  expect(received[1]!.id).not.toBe(received[0]!.id)
  expect(textOf(received[1]!)).toContain("新增水墨过渡效果")
})

it("includes a first-message package captured before session creation", async () => {
  draft([annotation], "new-conversation", "")
  const received: SendDesktopPromptInput[] = []
  const session = emptySessionView("created").session
  vi.stubGlobal("window", { desktop: { sessions: {
    create: async () => session,
    open: async () => emptySessionView("created"),
    sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
  } } })
  useDesktopSessionStore.setState({ activeSessionId: null, sessionView: null, workspaceMode: "outside_project", selectedProject: null, selectedModel: "test-model" })
  await useDesktopSessionStore.getState().startSession("")
  expect(received).toHaveLength(1)
  expect(textOf(received[0]!)).toContain(annotation.comment)
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:created"]!.browserAnnotations).toEqual([])
})

it.each(["编辑后的正文", ""])("preserves the original feedback when editing history without consuming the live draft: %s", async body => {
  const snapshot = formatBrowserAnnotationContext([annotation])!
  const sourceItems = [{ type: "text" as const, text: "原正文" + snapshot }]
  const view = emptySessionView("chat")
  view.messages = [{ id: "source", sessionId: "chat", inputId: "input", seq: 1, role: "user", metadata: {}, createdAt: 1, updatedAt: 1 }]
  view.inputs = [{ id: "input", sessionId: "chat", seq: 1, delivery: "queue", content: sourceItems[0]!.text, items: sourceItems, attachments: [], metadata: {}, createdAt: 1 }]
  useDesktopSessionStore.setState({ sessionView: view })
  const unsent = { ...annotation, id: "new-draft", comment: "主输入框未发送的批注" }
  draft([unsent])
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: { sessions: {
    editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) },
  } } })
  await useDesktopSessionStore.getState().editLatestMessage("source", body)
  expect(received).toHaveLength(1)
  expect(textOf(received[0]!)).toBe(body + snapshot)
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:chat"]!.browserAnnotations).toEqual([unsent])
})
