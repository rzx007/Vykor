import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"
import type { EditLatestDesktopPromptInput, SendDesktopPromptInput } from "@shared/session-types"
import {
  resetUtilityPanelRuntimeStatesForTests,
  writeUtilityPanelRuntimeState,
  writeUtilityPanelViewStates,
} from "@renderer/components/desktop/layout/main-layout/utility-panel/utility-panel-repository"
import { defaultUtilityPanelRuntimeState } from "@renderer/components/desktop/layout/main-layout/utility-panel/use-utility-panel-runtime"
import { readComposerRecovery } from "../composer-recovery"
import { composerDocument } from "../composer-document"
import { emptySessionView, resetDesktopSessionStore } from "../store-test-fixtures"
import { useDesktopSessionStore } from "../store"

const url = "http://127.0.0.1:52849/"
const snapshot: BrowserAnnotationSnapshot = {
  pageUrl: url, pageRevision: 1, ready: true, mode: "review", interactionVersion: 1,
  eventSequence: 1, selection: null, focusedAnnotationId: null, viewport: null,
  annotations: [{
    record: { id: "a-1", pageUrl: url, target: "section: 流", selector: "#flow", comment: "以水墨泼溅展现内容",
      locatorKind: "unique-id", tagName: "section", role: "region", name: "流" },
    status: "visible", rect: null,
  }],
}

function openBrowser(sessionId = "chat", scope = `session:${sessionId}`): void {
  writeUtilityPanelViewStates({ [scope]: { open: true, maximized: false, layout: null } })
  writeUtilityPanelRuntimeState(scope, {
    ...defaultUtilityPanelRuntimeState(), activeTabId: "browser-1",
    tabs: [{ id: "browser-1", tool: "browser", title: "回游" }],
    browserTabs: [{ id: "browser-1", title: "回游", url, input: url, loading: false, canGoBack: false, canGoForward: false }],
  })
}

beforeEach(() => {
  resetDesktopSessionStore()
  localStorage.clear()
  resetUtilityPanelRuntimeStatesForTests()
  useDesktopSessionStore.setState({ activeSessionId: "chat", sessionView: emptySessionView("chat") })
})
afterEach(() => { resetUtilityPanelRuntimeStatesForTests(); vi.unstubAllGlobals() })

it("automatically includes saved page annotations in the admitted message without changing the draft", async () => {
  openBrowser()
  const received: SendDesktopPromptInput[] = []
  const document = composerDocument([{ type: "text", text: "按批注改进" }])
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => snapshot },
    sessions: { sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) } },
  } })
  await useDesktopSessionStore.getState().sendMessage("按批注改进", { document })
  expect(received).toHaveLength(1)
  const text = received[0]!.items.filter(item => item.type === "text").map(item => item.text).join("")
  expect(text).toContain("按批注改进")
  expect(text).toContain("以水墨泼溅展现内容")
  expect(text).toContain("#flow")
  expect(text).toContain(url)
  expect(document.items).toEqual([{ type: "text", text: "按批注改进" }])
})

it("restores and retries the same annotation snapshot even after the page has closed", async () => {
  openBrowser()
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => snapshot },
    sessions: {
      checkPromptAccepted: async () => false,
      sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input); if (received.length === 1) throw new Error("offline") },
    },
  } })
  await expect(useDesktopSessionStore.getState().sendMessage("按批注改进")).rejects.toThrow("offline")
  const restored = readComposerRecovery()
  resetUtilityPanelRuntimeStatesForTests()
  useDesktopSessionStore.setState({ sessionRuntimes: restored.sessionRuntimes })
  await useDesktopSessionStore.getState().retryPromptSubmission(received[0]!.id, "chat")
  expect(received[0]!.items.some(item => item.type === "text" && item.text.includes("以水墨泼溅展现内容"))).toBe(true)
  expect(received[1]).toEqual(received[0])
})

it("does not attach another chat's browser annotations", async () => {
  openBrowser("other")
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => { throw new Error("must not read another chat") } },
    sessions: { sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) } },
  } })
  await useDesktopSessionStore.getState().sendMessage("普通消息")
  expect(received[0]!.items).toEqual([{ type: "text", text: "普通消息" }])
})

it("sends updated annotations with a new input ID after an identical message was accepted", async () => {
  openBrowser()
  const view = emptySessionView("chat")
  view.session.status = "running"
  useDesktopSessionStore.setState({ sessionView: view })
  let pageSnapshot = snapshot
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => pageSnapshot },
    sessions: { sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) } },
  } })
  await useDesktopSessionStore.getState().sendMessage("按批注改进")
  pageSnapshot = { ...snapshot, annotations: [{ ...snapshot.annotations[0]!, record: {
    ...snapshot.annotations[0]!.record, comment: "新增水墨过渡效果",
  } }] }
  await useDesktopSessionStore.getState().sendMessage("按批注改进")
  expect(received).toHaveLength(2)
  expect(received[1]!.id).not.toBe(received[0]!.id)
  expect(received[1]!.items.some(item => item.type === "text" && item.text.includes("新增水墨过渡效果"))).toBe(true)
})

it("keeps a failed annotation read retryable instead of sending without feedback", async () => {
  openBrowser()
  const received: SendDesktopPromptInput[] = []
  let broken = true
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => { if (broken) throw new Error("read failed"); return snapshot } },
    sessions: {
      checkPromptAccepted: async () => false,
      sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
    },
  } })
  await expect(useDesktopSessionStore.getState().sendMessage("按批注改进")).rejects.toThrow()
  expect(received).toEqual([])
  broken = false
  await useDesktopSessionStore.getState().sendMessage("按批注改进")
  expect(received[0]!.items.some(item => item.type === "text" && item.text.includes("以水墨泼溅展现内容"))).toBe(true)
})

it("replaces the old automatic annotation block when editing and resubmitting", async () => {
  openBrowser()
  const oldBlock = '\n\n<browser_annotations>\n{"url":"http://127.0.0.1:52849/","annotations":[{"target":"旧区域","selector":"#old","comment":"旧批注"}]}\n</browser_annotations>'
  const document = composerDocument([{ type: "text", text: "改进页面" + oldBlock }])
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => snapshot },
    sessions: { editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) } },
  } })
  await useDesktopSessionStore.getState().editLatestMessage("source", "改进页面", document)
  const text = received[0]!.items.filter(item => item.type === "text").map(item => item.text).join("")
  expect(text).toContain("改进页面")
  expect(text).toContain("以水墨泼溅展现内容")
  expect(text).not.toContain("旧批注")
  expect(text.match(/<browser_annotations>/g)).toHaveLength(1)
  expect(document.items[0]).toEqual({ type: "text", text: "改进页面" + oldBlock })
})

it("captures the draft page before creating the first session", async () => {
  openBrowser("", "draft:outside-project")
  const received: SendDesktopPromptInput[] = []
  const session = emptySessionView("created").session
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => snapshot },
    sessions: {
      create: async () => { resetUtilityPanelRuntimeStatesForTests(); return session },
      open: async () => emptySessionView("created"),
      sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) },
    },
  } })
  useDesktopSessionStore.setState({ activeSessionId: null, sessionView: null, workspaceMode: "outside_project", selectedProject: null, selectedModel: "test-model" })
  await useDesktopSessionStore.getState().startSession("按批注创建页面")
  expect(received[0]!.items.some(item => item.type === "text" && item.text.includes("以水墨泼溅展现内容"))).toBe(true)
})

it("merges duplicate sends while the annotation read is pending", async () => {
  openBrowser()
  let release!: (value: BrowserAnnotationSnapshot) => void
  const reading = new Promise<BrowserAnnotationSnapshot>(resolve => { release = resolve })
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: () => reading },
    sessions: { sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) } },
  } })
  const first = useDesktopSessionStore.getState().sendMessage("按批注改进")
  const second = useDesktopSessionStore.getState().sendMessage("按批注改进")
  release(snapshot)
  await Promise.all([first, second])
  expect(received).toHaveLength(1)
  expect(received[0]!.items.some(item => item.type === "text" && item.text.includes("以水墨泼溅展现内容"))).toBe(true)
})

it("merges duplicate edits while the annotation read is pending", async () => {
  openBrowser()
  let release!: (value: BrowserAnnotationSnapshot) => void
  const reading = new Promise<BrowserAnnotationSnapshot>(resolve => { release = resolve })
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: () => reading },
    sessions: { editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) } },
  } })
  const first = useDesktopSessionStore.getState().editLatestMessage("source", "按批注改进")
  const second = useDesktopSessionStore.getState().editLatestMessage("source", "按批注改进")
  release(snapshot)
  await Promise.all([first, second])
  expect(received).toHaveLength(1)
  expect(received[0]!.items.some(item => item.type === "text" && item.text.includes("以水墨泼溅展现内容"))).toBe(true)
})

it.each([false, true])("settles an older edit replaced while its annotations are loading (failure=%s)", async failed => {
  openBrowser()
  const releases: Array<() => void> = []
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: () => new Promise<BrowserAnnotationSnapshot>((resolve, reject) => {
      const first = releases.length === 0
      releases.push(() => failed && first ? reject(new Error("old read failed")) : resolve(snapshot))
    }) },
    sessions: { editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) } },
  } })
  const first = useDesktopSessionStore.getState().editLatestMessage("source", "第一次编辑")
  const second = useDesktopSessionStore.getState().editLatestMessage("source", "替换为新编辑")
  releases[0]!()
  await first
  releases[1]!()
  await second
  expect(received).toHaveLength(1)
  expect(received[0]!.items[0]).toEqual({ type: "text", text: "替换为新编辑" })
  expect(useDesktopSessionStore.getState().sessionRuntimes.chat!.operations).toEqual({})
})

it("does not read newly added annotations when retrying an originally empty snapshot", async () => {
  openBrowser()
  const received: SendDesktopPromptInput[] = []
  let pageSnapshot: BrowserAnnotationSnapshot = { ...snapshot, annotations: [] }
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => pageSnapshot },
    sessions: {
      checkPromptAccepted: async () => false,
      sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input); if (received.length === 1) throw new Error("offline") },
    },
  } })
  await expect(useDesktopSessionStore.getState().sendMessage("普通消息")).rejects.toThrow("offline")
  pageSnapshot = snapshot
  useDesktopSessionStore.setState({ sessionRuntimes: readComposerRecovery().sessionRuntimes })
  await useDesktopSessionStore.getState().retryPromptSubmission(received[0]!.id, "chat")
  expect(received[1]).toEqual(received[0])
  expect(received[1]!.items).toEqual([{ type: "text", text: "普通消息" }])
})

it.each([false, true])("does not restore a deleted edit runtime when annotation reading finishes (failure=%s)", async failed => {
  openBrowser()
  let release!: () => void
  const reading = new Promise<BrowserAnnotationSnapshot>((resolve, reject) => {
    release = () => failed ? reject(new Error("read failed")) : resolve(snapshot)
  })
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: () => reading },
    sessions: { editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) } },
  } })
  const request = useDesktopSessionStore.getState().editLatestMessage("source", "按批注改进")
  useDesktopSessionStore.setState({ sessionRuntimes: {} })
  release()
  await request
  expect(received).toEqual([])
  expect(useDesktopSessionStore.getState().sessionRuntimes.chat).toBeUndefined()
})

it("does not submit again when the input is confirmed while reading annotations", async () => {
  openBrowser()
  let release!: (value: BrowserAnnotationSnapshot) => void
  const reading = new Promise<BrowserAnnotationSnapshot>(resolve => { release = resolve })
  const received: SendDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: () => reading },
    sessions: { sendPrompt: async (input: SendDesktopPromptInput) => { received.push(input) } },
  } })
  const request = useDesktopSessionStore.getState().sendMessage("按批注改进")
  useDesktopSessionStore.setState(state => {
    const runtime = state.sessionRuntimes.chat!
    const [id, pending] = Object.entries(runtime.pendingPromptSubmissions)[0]!
    return { sessionRuntimes: { chat: { ...runtime, pendingPromptSubmissions: { [id]: { ...pending, phase: "accepted" } } } } }
  })
  release(snapshot)
  await request
  expect(received).toEqual([])
})

it("keeps appended text and file references while replacing the original annotation block", async () => {
  openBrowser()
  const oldBlock = '\n\n<browser_annotations>\n{"url":"http://127.0.0.1:52849/","annotations":[{"target":"旧区域","selector":"#old","comment":"旧批注"}]}\n</browser_annotations>'
  const sourceItems = [{ type: "text" as const, text: "改进页面" + oldBlock }]
  const view = emptySessionView("chat")
  view.messages = [{ id: "source", sessionId: "chat", inputId: "input", seq: 1, role: "user", metadata: {}, createdAt: 1, updatedAt: 1 }]
  view.inputs = [{ id: "input", sessionId: "chat", seq: 1, delivery: "queue", content: sourceItems[0]!.text, items: sourceItems, attachments: [], metadata: {}, createdAt: 1 }]
  useDesktopSessionStore.setState({ sessionView: view })
  const mention = { type: "mention" as const, name: "theme.css", path: "theme.css" }
  const document = composerDocument([...sourceItems, { type: "text", text: "\n再增加留白" }, mention])
  const received: EditLatestDesktopPromptInput[] = []
  vi.stubGlobal("window", { desktop: {
    browser: { readAnnotations: async () => snapshot },
    sessions: { editLatestPrompt: async (input: EditLatestDesktopPromptInput) => { received.push(input) } },
  } })
  await useDesktopSessionStore.getState().editLatestMessage("source", "", document)
  const text = received[0]!.items.filter(item => item.type === "text").map(item => item.text).join("")
  expect(text).toContain("改进页面\n再增加留白")
  expect(text).toContain("以水墨泼溅展现内容")
  expect(text).not.toContain("旧批注")
  expect(text.match(/<browser_annotations>/g)).toHaveLength(1)
  expect(received[0]!.items).toContainEqual(mention)
})
