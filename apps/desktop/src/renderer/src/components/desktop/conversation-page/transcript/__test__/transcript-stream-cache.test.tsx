// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

const entryBuilds = vi.hoisted(() => ({ count: 0 }))

vi.mock("../../message/conversation-turn-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../message/conversation-turn-model")>()
  return {
    ...actual,
    buildConversationEntries: (...args: Parameters<typeof actual.buildConversationEntries>) => {
      entryBuilds.count += 1
      return actual.buildConversationEntries(...args)
    },
  }
})

vi.mock("@renderer/components/ui/message-scroller", async () => {
  const { createElement } = await import("react")
  return {
    MessageScrollerItem: ({ children }: { children?: ReactNode }) =>
      createElement("div", null, children),
  }
})

vi.mock("../../message/assistant-message", async () => {
  const { createElement } = await import("react")
  return {
    AssistantMessage: ({ parts }: { parts: DesktopSessionPart[] }) =>
      createElement("p", { "data-assistant-message": true },
        parts.map((part) => part.text ?? "").join("")),
  }
})

vi.mock("../../message/message-block", () => ({
  AssistantMessageActions: () => null,
  MessageBlock: () => null,
}))
vi.mock("../../message/context-compaction-divider", () => ({ ContextCompactionDivider: () => null }))
vi.mock("../../message/model-retry-notice", () => ({ ModelRetryNotice: () => null }))
vi.mock("../../message/model-usage-notice", () => ({ ModelUsageNotice: () => null }))
vi.mock("../../message/task-duration", () => ({ TaskDuration: () => null }))
vi.mock("../../message/run-error-notice", () => ({ RunErrorNotice: () => null }))
vi.mock("../../message/content-entrance", () => ({ ContentEntrance: ({ children }: { children?: ReactNode }) => children }))

import { ConversationTranscript } from "../transcript"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  entryBuilds.count = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe("streaming transcript cache", () => {
  it("reuses entries and shows appended text", () => {
    const fixture = createFixture()
    act(() => root.render(<ConversationTranscript {...fixture.props} />))
    expect(entryBuilds.count).toBe(1)
    expect(container.textContent).toContain("A")

    const appendedPart = { ...fixture.part, text: "AB", updatedAt: 2 }
    act(() => root.render(<ConversationTranscript {...fixture.props} parts={[appendedPart]} />))
    expect(entryBuilds.count).toBe(1)
    expect(container.textContent).toContain("AB")
  })

  it("rebuilds entries when a new message is added", () => {
    const fixture = createFixture()
    act(() => root.render(<ConversationTranscript {...fixture.props} />))
    expect(entryBuilds.count).toBe(1)

    const nextMessage: DesktopSessionMessage = {
      ...fixture.message,
      id: "assistant-2",
      seq: 2,
      updatedAt: 3,
    }
    const nextPart: DesktopSessionPart = {
      ...fixture.part,
      id: "part-2",
      messageId: nextMessage.id,
      seq: 2,
      text: "C",
      createdAt: 3,
      updatedAt: 3,
    }
    act(() => root.render(
      <ConversationTranscript
        {...fixture.props}
        messages={[...fixture.props.messages, nextMessage]}
        parts={[{ ...fixture.part, text: "AB", updatedAt: 2 }, nextPart]}
      />
    ))
    expect(entryBuilds.count).toBe(2)
    expect(container.textContent).toContain("ABC")
  })
})

function createFixture() {
  const message: DesktopSessionMessage = {
    id: "assistant-1",
    sessionId: "session-1",
    seq: 1,
    role: "assistant",
    inputId: "input-1",
    runId: "run-1",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const part: DesktopSessionPart = {
    id: "part-1",
    sessionId: "session-1",
    messageId: message.id,
    seq: 1,
    type: "text",
    status: "running",
    text: "A",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const messages = [message]
  const runs: DesktopSessionRun[] = [{
    id: "run-1",
    sessionId: "session-1",
    inputId: "input-1",
    status: "running",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }]
  const props = {
    messages,
    parts: [part],
    runs,
    running: true,
    canEditLastUserMessage: false,
    onEditLastUserMessage: () => undefined,
    onCopyAssistantMessage: () => undefined,
    onOpenFile: () => undefined,
    canOpenReview: false,
    onOpenReview: () => undefined,
    onOpenTerminal: () => undefined,
  }
  return { message, part, props }
}
