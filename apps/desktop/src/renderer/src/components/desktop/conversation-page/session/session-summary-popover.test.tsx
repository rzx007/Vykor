// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { resetGitChangesQueryCacheForTests } from "@renderer/lib/git-changes-query"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import type { DesktopSessionView } from "@shared/session-types"
import { SessionSummaryPopover } from "./session-summary-popover"

let root: Root
let container: HTMLDivElement
const changes = vi.fn()
const openReview = vi.fn()
const openAgents = vi.fn()
const pickFiles = vi.fn()
const openFile = vi.fn()
const openExternal = vi.fn()
const openAttachment = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetGitChangesQueryCacheForTests()
  changes.mockResolvedValue({
    rootPath: "D:/repo",
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      git: { changes },
      window: { openExternal },
      attachments: { open: openAttachment },
    },
  })
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
  resetGitChangesQueryCacheForTests()
})

async function renderSummary(
  view = emptySessionView("chat"),
  canOpenReview = true,
  workspacePath = "D:/repo"
): Promise<void> {
  await act(async () => {
    root.render(
      <SessionSummaryPopover
        view={view}
        workspace={{
          id: "repo",
          name: "repo",
          path: workspacePath,
          available: true,
          lastOpenedAt: 1,
        }}
        canOpenReview={canOpenReview}
        onOpenReview={openReview}
        onOpenAgents={openAgents}
        onOpenFile={openFile}
        onPickFiles={pickFiles}
      />
    )
  })
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label
  )
  expect(button, `missing button: ${label}`).toBeTruthy()
  await act(async () => {
    button!.click()
    await new Promise((resolve) => window.setTimeout(resolve, 30))
  })
}

it("queries only when opened and sends the same uncommitted scope to review", async () => {
  changes.mockResolvedValue({
    rootPath: "D:/repo",
    files: [{ path: "manual.ts", additions: 8, deletions: 2, status: "modified", binary: false }],
    totalAdditions: 8,
    totalDeletions: 2,
  })
  await renderSummary()
  expect(changes).not.toHaveBeenCalled()
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).toContain("+8")
  expect(document.body.textContent).toContain("−2")
  await click("查看工作区未提交变更")
  expect(openReview).toHaveBeenCalledWith(undefined, "uncommitted")
})

it("keeps agent counts inside the summary and opens their existing panel", async () => {
  const view = emptySessionView("chat")
  view.tasks = ["running", "completed", "failed"].map((status, index) => ({
    id: String(index),
    sessionId: "chat",
    childSessionId: `child-${index}`,
    type: "agent",
    status: status as "running" | "completed" | "failed",
    description: "task",
    cwd: "D:/repo",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }))
  await renderSummary(view)
  expect(container.querySelector('[aria-label="查看子智能体"]')).toBeNull()
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).toContain("1 运行中")
  expect(document.body.textContent).toContain("1 完成")
  expect(document.body.textContent).toContain("1 失败")
  await click("查看聊天子智能体")
  expect(openAgents).toHaveBeenCalledOnce()
})

it("closes on a chat switch and discards a late git response", async () => {
  let resolveChanges!: (value: unknown) => void
  changes.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveChanges = resolve
      })
  )
  await renderSummary()
  await click("当前聊天的工作摘要")
  await renderSummary(emptySessionView("other-chat"), true, "D:/other-repo")
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  changes.mockResolvedValueOnce({
    rootPath: "D:/other-repo",
    files: [],
    totalAdditions: 7,
    totalDeletions: 0,
  })
  await click("当前聊天的工作摘要")
  await act(async () => {
    resolveChanges({ rootPath: "D:/repo", files: [], totalAdditions: 999, totalDeletions: 0 })
  })
  expect(document.body.textContent).not.toContain("+999")
  expect(document.body.textContent).toContain("+7")
})

it("refreshes settled work while ignoring streaming text and stops querying when closed", async () => {
  const view = emptySessionView("chat")
  await renderSummary(view)
  await click("当前聊天的工作摘要")
  const firstCount = changes.mock.calls.length
  await renderSummary({
    ...view,
    parts: [
      {
        id: "text",
        sessionId: "chat",
        messageId: "assistant",
        seq: 1,
        type: "text",
        text: "streaming",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  })
  expect(changes).toHaveBeenCalledTimes(firstCount)
  const settledView: DesktopSessionView = {
    ...view,
    runs: [
      {
        id: "run",
        sessionId: "chat",
        status: "completed",
        metadata: {},
        createdAt: 1,
        updatedAt: 3,
      },
    ],
  }
  await renderSummary(settledView)
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 350))
  })
  expect(changes).toHaveBeenCalledTimes(firstCount + 1)
  await click("当前聊天的工作摘要")
  await renderSummary({ ...settledView, runs: [{ ...settledView.runs[0]!, updatedAt: 4 }] })
  expect(changes).toHaveBeenCalledTimes(firstCount + 1)
})

it("opens discovered pages and sent attachments with their native actions", async () => {
  const view = emptySessionView("chat")
  view.parts = [
    {
      id: "fetch",
      sessionId: "chat",
      messageId: "assistant",
      seq: 1,
      type: "tool",
      toolName: "WebFetch",
      toolUseId: "fetch",
      input: { url: "https://docs.example/guide" },
      output: { content: [{ type: "text", text: "page" }] },
      status: "completed",
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
    },
  ]
  view.inputs = [
    {
      id: "input",
      sessionId: "chat",
      seq: 1,
      delivery: "queue",
      content: "",
      items: [],
      attachments: [
        {
          id: "a",
          sessionId: "chat",
          inputId: "input",
          assetId: "asset-1",
          seq: 1,
          intent: "auto",
          displayName: "spec.txt",
          mediaType: "text/plain",
          sizeBytes: 4,
          metadata: {},
          createdAt: 1,
        },
      ],
      metadata: {},
      createdAt: 1,
    },
  ]
  await renderSummary(view)
  await click("当前聊天的工作摘要")
  await click("打开资料 docs.example/guide")
  expect(openExternal).toHaveBeenCalledWith("https://docs.example/guide")
  await click("当前聊天的工作摘要")
  await click("打开资料 spec.txt")
  expect(openAttachment).toHaveBeenCalledWith({ assetId: "asset-1" })
})

it("shows Git failures with retry and does not query non-Git directories", async () => {
  await renderSummary(emptySessionView("chat"), false)
  await click("当前聊天的工作摘要")
  expect(document.querySelector('section[aria-label="工作区变更"]')).toBeNull()
  expect(document.body.textContent).not.toContain("非 Git 仓库")
  expect(document.querySelector('section[aria-label="聊天子智能体"]')).not.toBeNull()
  expect(changes).not.toHaveBeenCalled()
  changes.mockRejectedValueOnce(new Error("git unavailable"))
  await renderSummary(emptySessionView("git-chat"))
  await click("当前聊天的工作摘要")
  expect(document.body.textContent).toContain("git unavailable")
  await click("刷新工作区变更")
  expect(document.body.textContent).not.toContain("git unavailable")
  expect(document.body.textContent).toContain("暂无变更")
})

it("expands sources, opens files, and adds files to the composer draft", async () => {
  const view = emptySessionView("chat")
  view.inputs = [
    {
      id: "input",
      sessionId: "chat",
      seq: 1,
      delivery: "queue",
      content: "",
      items: ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => ({
        type: "mention",
        name,
        path: name,
      })),
      attachments: [],
      metadata: {},
      createdAt: 1,
    },
  ]
  await renderSummary(view)
  await click("当前聊天的工作摘要")
  expect(document.querySelectorAll("[data-summary-source]")).toHaveLength(3)
  await click("查看全部 4 项")
  expect(document.querySelectorAll("[data-summary-source]")).toHaveLength(4)
  await click("打开资料 a.ts")
  expect(openFile).toHaveBeenCalledWith("D:/repo/a.ts")
  await click("当前聊天的工作摘要")
  await click("添加资料到输入框")
  expect(pickFiles).toHaveBeenCalledOnce()
})
