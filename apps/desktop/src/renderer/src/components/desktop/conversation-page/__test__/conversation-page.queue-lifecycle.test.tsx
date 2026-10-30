// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import {
  emptySessionView,
  resetDesktopSessionStore,
} from "@renderer/stores/desktop-session/store-test-fixtures"
import { createEmptySessionRuntime } from "@renderer/stores/desktop-session/operation-state"
import {
  selectComposerDocumentText,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"

// Keep the actual page/queue relationship; omit unrelated native surfaces and the rich editor.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../composer/composer", () => ({
  Composer: ({ draft }: { draft: ComposerDocument }) => (
    <textarea aria-label="正文草稿" value={selectComposerDocumentText(draft)} readOnly />
  ),
}))
vi.mock("../transcript/transcript", () => ({ ConversationTranscript: () => null }))
vi.mock("../transcript/conversation-find", () => ({ ConversationFind: () => null }))
vi.mock("../transcript/conversation-preview-rail", () => ({ ConversationPreviewRail: () => null }))
vi.mock("../transcript/conversation-transcript-skeleton", () => ({
  ConversationTranscriptSkeletonOverlay: () => null,
}))
vi.mock("../transcript/conversation-scroller", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    ConversationScroller: Box,
    ConversationScrollerProvider: Box,
    ConversationScrollerViewport: Box,
    ConversationScrollerContent: Box,
    ConversationScrollerButton: () => null,
  }
})
vi.mock("@renderer/components/desktop/open-with", () => ({ OpenWithSplitButton: () => null }))
vi.mock("@renderer/components/desktop/tools/side-chat/side-chat-selection-actions", () => ({
  SideChatSelectionActions: () => null,
}))
vi.mock("../session/project-info-popover", () => ({ ProjectInfoButton: () => null }))
vi.mock("../session/session-summary-popover", () => ({ SessionSummaryPopover: () => null }))
vi.mock("../session/session-more-menu", () => ({ SessionMoreMenu: () => null }))
vi.mock("../session/session-action-dialogs", () => ({
  useSessionActionDialogs: () => ({ dialogs: null }),
}))
vi.mock("../shared/use-show-reasoning", () => ({ useShowReasoning: () => false }))
import { ConversationPane } from "../conversation-page"

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  resetDesktopSessionStore()
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetDesktopSessionStore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("reconciles sending, accepted and queued snapshots into one queue without remounting or clearing the composer", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  const view = emptySessionView("chat")
  const active = {
    id: "active",
    sessionId: "chat",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  } as DesktopSessionRun
  const input = {
    id: "next",
    sessionId: "chat",
    seq: 2,
    delivery: "queue",
    content: "如 nestjs",
    items: [],
    attachments: [],
    createdAt: 2,
    metadata: {},
  } as DesktopSessionInput
  const queued = {
    ...active,
    id: "queued",
    inputId: input.id,
    status: "pending",
    createdAt: 2,
  } as DesktopSessionRun
  const send = vi.fn()
  useDesktopSessionStore.setState({
    activeSessionId: "chat",
    sessions: [view.session],
    loadStatus: "idle",
    sessionView: { ...view, runs: [active] },
    refreshGoal: vi.fn(async () => {}),
    sendMessage: send,
  })
  useDesktopSessionStore.getState().setComposerDraftText("session:chat", "正文草稿不能丢")
  await act(async () =>
    root.render(
      <ConversationPane
        panelOpen
        canOpenReview={false}
        onTogglePanel={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenTerminal={vi.fn()}
        onOpenAgents={vi.fn()}
      />
    )
  )
  const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="正文草稿"]')!
  for (const [index, phase] of [
    "submitting",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
  ].entries()) {
    const authoritative = index >= 3
    await act(async () =>
      useDesktopSessionStore.setState({
        sessionView: {
          ...view,
          cursor: index + 1,
          runs: authoritative ? [active, queued] : [active],
          inputs: authoritative ? [input] : [],
        },
        sessionRuntimes: {
          chat: {
            ...createEmptySessionRuntime(),
            pendingPromptSubmissions: {
              next: {
                id: input.id,
                sessionId: "chat",
                content: input.content,
                items: [],
                attachments: [],
                createdAt: 2,
                phase: phase as "submitting" | "accepted",
                placement: "queue",
              },
            },
          },
        },
      })
    )
    expect(host.querySelectorAll('[aria-label="待处理消息"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(1)
    expect(host.querySelector('[aria-label="正文草稿"]')).toBe(composer)
    expect(composer.value).toBe("正文草稿不能丢")
  }
  await act(async () =>
    useDesktopSessionStore.setState({
      sessionView: { ...view, runs: [active] },
      sessionRuntimes: { chat: createEmptySessionRuntime() },
    })
  )
  expect(host.querySelector('[aria-label="待处理消息"]')).toBeNull()
  expect(host.querySelector('[aria-label="正文草稿"]')).toBe(composer)
  const other = emptySessionView("other")
  await act(async () => {
    useDesktopSessionStore.getState().setComposerDraftText("session:other", "另一份草稿")
    useDesktopSessionStore.setState({
      activeSessionId: "other",
      sessions: [view.session, other.session],
      sessionView: other,
    })
  })
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="正文草稿"]')!.value).toBe(
    "另一份草稿"
  )
  await act(async () =>
    useDesktopSessionStore.setState({ activeSessionId: "chat", sessionView: view })
  )
  expect(host.querySelectorAll('[aria-label="正文草稿"]')).toHaveLength(1)
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="正文草稿"]')!.value).toBe(
    "正文草稿不能丢"
  )
  expect(send).not.toHaveBeenCalled()
  expect(
    errors.mock.calls.filter((args) => args.some((value) => String(value).includes("same key")))
  ).toHaveLength(0)
})
