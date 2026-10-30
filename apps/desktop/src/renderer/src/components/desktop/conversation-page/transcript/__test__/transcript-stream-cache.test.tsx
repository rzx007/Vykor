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
const work = vi.hoisted(() => ({ turnCommits: new Map<string, number>(), workspaceReads: 0 }))

vi.mock("@vykor/application-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vykor/application-client")>()
  return {
    ...actual,
    readWorkspaceChangesMetadata: (
      ...args: Parameters<typeof actual.readWorkspaceChangesMetadata>
    ) => {
      work.workspaceReads += 1
      return actual.readWorkspaceChangesMetadata(...args)
    },
  }
})

// Profile the real process subtree without mounting Markdown, file previews or Electron APIs.
vi.mock("../turn-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../turn-process")>()
  const { createElement, Profiler } = await import("react")
  return {
    ...actual,
    TurnProcess: (props: React.ComponentProps<typeof actual.TurnProcess>) =>
      createElement(
        Profiler,
        {
          id: props.plan[0]?.key ?? "empty",
          onRender: (id) => work.turnCommits.set(id, (work.turnCommits.get(id) ?? 0) + 1),
        },
        createElement(actual.TurnProcess, props)
      ),
  }
})

vi.mock("../../message/models/conversation-turn-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../message/models/conversation-turn-model")>()
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

vi.mock("../../message/blocks/assistant-message", async () => {
  const { createElement } = await import("react")
  return {
    AssistantMessage: ({ parts }: { parts: DesktopSessionPart[] }) =>
      createElement(
        "p",
        { "data-assistant-message": true },
        parts.map((part) => part.text ?? "").join("")
      ),
  }
})

vi.mock("../../message/blocks/message-block", () => ({ MessageBlock: () => null }))
vi.mock("../../message/blocks/message-actions", () => ({ AssistantMessageActions: () => null }))
vi.mock("../../message/notices/context-compaction-divider", () => ({
  ContextCompactionDivider: () => null,
}))
vi.mock("../../message/notices/model-retry-notice", () => ({ ModelRetryNotice: () => null }))
vi.mock("../../message/notices/model-usage-notice", () => ({ ModelUsageNotice: () => null }))
vi.mock("../../message/activity/task-duration", () => ({ TaskDuration: () => null }))
vi.mock("../../message/notices/run-error-notice", () => ({ RunErrorNotice: () => null }))
vi.mock("../../message/blocks/content-entrance", () => ({
  ContentEntrance: ({ children }: { children?: ReactNode }) => children,
}))

import { ConversationTranscript } from "../transcript"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  entryBuilds.count = 0
  work.turnCommits.clear()
  work.workspaceReads = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe("streaming transcript cache", () => {
  it("keeps earlier appended text when another existing part starts streaming", () => {
    const fixture = createFixture()
    const other: DesktopSessionPart = {
      ...fixture.part,
      id: "other-text",
      seq: 2,
      text: "X",
    }
    act(() =>
      root.render(<ConversationTranscript {...fixture.props} parts={[fixture.part, other]} />)
    )
    const appended = { ...fixture.part, text: "AB", updatedAt: 2 }
    act(() => root.render(<ConversationTranscript {...fixture.props} parts={[appended, other]} />))

    act(() =>
      root.render(
        <ConversationTranscript
          {...fixture.props}
          parts={[appended, { ...other, text: "XY", updatedAt: 3 }]}
        />
      )
    )

    expect(container.textContent).toContain("ABXY")
  })

  it("keeps appended text when the parent renders again without another delta", () => {
    const fixture = createHistoryFixture()
    act(() => root.render(<ConversationTranscript {...fixture.props} />))
    const props = {
      ...fixture.props,
      parts: [...fixture.historyParts, { ...fixture.part, text: "AB", updatedAt: 2 }],
    }
    act(() => root.render(<ConversationTranscript {...props} />))
    const commits = new Map(work.turnCommits)

    act(() => root.render(<ConversationTranscript {...props} />))

    expect(container.textContent).toContain("AB")
    expect(work.turnCommits).toEqual(commits)
  })

  it("keeps appended text when hidden reasoning changes", () => {
    const fixture = createHistoryFixture()
    const reasoning: DesktopSessionPart = {
      ...fixture.part,
      id: "reasoning",
      seq: 2,
      type: "reasoning",
      text: "hidden",
    }
    act(() =>
      root.render(
        <ConversationTranscript {...fixture.props} parts={[...fixture.props.parts, reasoning]} />
      )
    )
    const appended = { ...fixture.part, text: "AB", updatedAt: 2 }
    act(() =>
      root.render(
        <ConversationTranscript
          {...fixture.props}
          parts={[...fixture.historyParts, appended, reasoning]}
        />
      )
    )
    const commits = new Map(work.turnCommits)

    act(() =>
      root.render(
        <ConversationTranscript
          {...fixture.props}
          parts={[
            ...fixture.historyParts,
            appended,
            { ...reasoning, text: "hidden reasoning", updatedAt: 3 },
          ]}
        />
      )
    )

    expect(container.textContent).toContain("AB")
    expect(container.textContent).not.toContain("hidden")
    expect(work.turnCommits).toEqual(commits)
  })

  it("does not commit historical turns or reparse workspace summaries while text is appended", () => {
    const fixture = createHistoryFixture()
    act(() => root.render(<ConversationTranscript {...fixture.props} />))
    const historicalCommits = work.turnCommits.get("assistant-old")
    const activeCommits = work.turnCommits.get("assistant-1") ?? 0
    const workspaceReads = work.workspaceReads
    expect(historicalCommits).toBeGreaterThan(0)
    expect(workspaceReads).toBeGreaterThan(0)

    for (const text of ["AB", "ABC", "ABCD"]) {
      act(() =>
        root.render(
          <ConversationTranscript
            {...fixture.props}
            parts={[...fixture.historyParts, { ...fixture.part, text, updatedAt: 4 }]}
          />
        )
      )
    }

    expect(container.textContent).toContain("old reply")
    expect(container.textContent).toContain("ABCD")
    expect(work.turnCommits.get("assistant-old")).toBe(historicalCommits)
    expect(work.turnCommits.get("assistant-1")).toBe(activeCommits + 3)
    expect(work.workspaceReads).toBe(workspaceReads)
    expect(entryBuilds.count).toBe(1)
  })

  it("updates historical turns when their run metadata changes", () => {
    const fixture = createHistoryFixture()
    act(() => root.render(<ConversationTranscript {...fixture.props} />))
    const historicalCommits = work.turnCommits.get("assistant-old") ?? 0
    const workspaceReads = work.workspaceReads
    act(() =>
      root.render(
        <ConversationTranscript
          {...fixture.props}
          runs={fixture.props.runs.map((run) =>
            run.id === "run-old"
              ? {
                  ...run,
                  metadata: {
                    workspaceChanges: {
                      version: 1,
                      status: "unavailable",
                      reason: "concurrent_run_overlap",
                      files: [],
                      fileCount: 0,
                      totalLines: 0,
                      truncated: false,
                    },
                  },
                }
              : run
          )}
        />
      )
    )

    expect(work.turnCommits.get("assistant-old")).toBeGreaterThan(historicalCommits)
    expect(work.workspaceReads).toBeGreaterThan(workspaceReads)
    expect(container.textContent).toContain("old reply")
  })

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
    act(() =>
      root.render(
        <ConversationTranscript
          {...fixture.props}
          messages={[...fixture.props.messages, nextMessage]}
          parts={[{ ...fixture.part, text: "AB", updatedAt: 2 }, nextPart]}
        />
      )
    )
    expect(entryBuilds.count).toBe(2)
    expect(container.textContent).toContain("ABC")
  })
})

function createHistoryFixture() {
  const fixture = createFixture()
  const oldMessage: DesktopSessionMessage = {
    ...fixture.message,
    id: "assistant-old",
    seq: 0,
    inputId: "input-old",
    runId: "run-old",
  }
  const historyParts: DesktopSessionPart[] = [
    {
      ...fixture.part,
      id: "part-old",
      messageId: oldMessage.id,
      seq: 0,
      status: "completed",
      text: "old reply",
    },
  ]
  const oldRun: DesktopSessionRun = {
    ...fixture.props.runs[0]!,
    id: "run-old",
    inputId: "input-old",
    status: "completed",
    metadata: {
      workspaceChanges: {
        version: 1,
        status: "complete",
        repositoryRoot: "D:/repo",
        files: [],
        fileCount: 0,
        totalLines: 0,
        truncated: false,
      },
    },
  }
  return {
    ...fixture,
    historyParts,
    props: {
      ...fixture.props,
      messages: [oldMessage, ...fixture.props.messages],
      parts: [...historyParts, fixture.part],
      runs: [oldRun, ...fixture.props.runs],
    },
  }
}

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
  const runs: DesktopSessionRun[] = [
    {
      id: "run-1",
      sessionId: "session-1",
      inputId: "input-1",
      status: "running",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
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
