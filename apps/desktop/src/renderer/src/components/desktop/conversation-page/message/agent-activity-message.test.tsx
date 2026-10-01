// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import { AssistantMessage } from "./assistant-message"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { createActivityState } from "@renderer/stores/desktop-session/activity-state"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"

let root: Root
let container: HTMLDivElement
const openAgents = vi.fn()
const call: DesktopSessionPart = {
  id: "spawn",
  sessionId: "main",
  messageId: "message",
  seq: 2,
  type: "tool",
  toolName: "Agent",
  toolUseId: "spawn-call",
  input: { description: "检查消息渲染", prompt: "private instructions" },
  status: "completed",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
  output: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "job",
          action: "created",
          jobKind: "agent",
          jobId: "task-1",
          sessionId: "child-1",
          label: "检查消息渲染",
        }),
      },
    ],
  },
}
const task: DesktopSessionTask = {
  id: "task-1",
  sessionId: "main",
  childSessionId: "child-1",
  type: "agent",
  status: "running",
  description: "检查消息渲染",
  cwd: "/repo",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}
const callbacks = {
  onOpenFile: vi.fn(),
  canOpenReview: false,
  onOpenReview: vi.fn(),
  onOpenTerminal: vi.fn(),
}

beforeEach(() => {
  useDesktopSessionStore.setState({ activity: createActivityState() })
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  openAgents.mockClear()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function render(parts: DesktopSessionPart[], tasks: DesktopSessionTask[] = []) {
  act(() =>
    root.render(
      <AssistantMessage
        {...callbacks}
        parts={parts}
        tasks={tasks}
        streaming={false}
        onOpenAgents={openAgents}
      />
    )
  )
}

it("separates delegation from adjacent tool groups without changing order", () => {
  render(
    [
      { ...call, id: "read-before", toolName: "Read", output: undefined, seq: 1 },
      call,
      { ...call, id: "read-after", toolName: "Read", output: undefined, seq: 3 },
    ],
    [task]
  )
  const buttons = [...container.querySelectorAll("button")]
  expect(buttons).toHaveLength(3)
  expect(buttons[0].textContent).toContain("1 次")
  expect(buttons[1]).toBe(container.querySelector("[data-agent-activity]"))
  expect(buttons[1].textContent).toContain("检查消息渲染")
  expect(buttons[2].textContent).toContain("1 次")
  expect(container.textContent).not.toContain("private instructions")
  act(() => buttons[1].click())
  expect(openAgents).toHaveBeenCalledWith("task-1")
})

it("follows the linked task rather than the completed spawn call", () => {
  render([call], [task])
  const row = container.querySelector("[data-agent-activity]")
  expect(row?.textContent).toContain("运行中")
  render([call], [{ ...task, status: "completed" }])
  expect(container.querySelector("[data-agent-activity]")).toBe(row)
  expect(row?.textContent).toContain("已完成")
  render([call], [{ ...task, status: "failed" }])
  expect(row?.textContent).toContain("失败")
})

it("does not claim completion when the task has not arrived", () => {
  render([call])
  expect(container.textContent).toContain("已派出")
  expect(container.textContent).not.toContain("已完成")
  expect(container.querySelector<HTMLButtonElement>("[data-agent-activity]")?.disabled).toBe(true)
})

it("keeps failed dispatch visible without pretending an agent is running", () => {
  render([{ ...call, status: "failed", isError: true, output: "dispatch failed" }])
  expect(container.textContent).toContain("启动失败")
  expect(container.textContent).not.toContain("工具查看")
})

it("does not confuse agents with the same description", () => {
  render([call], [{ ...task, id: "another-task", status: "failed" }, task])
  expect(container.querySelector('[role="status"]:not([aria-hidden="true"])')?.textContent).toBe(
    "运行中"
  )
})

it("matches legacy separate results and wrapped input without exposing the prompt", () => {
  render(
    [
      {
        ...call,
        status: "running",
        output: undefined,
        input: { arguments: { prompt: "private instructions", description: "检查消息渲染" } },
      },
      { ...call, id: "result", type: "tool_result", toolName: undefined },
    ],
    [task]
  )
  expect(container.querySelector('[role="status"]:not([aria-hidden="true"])')?.textContent).toBe(
    "运行中"
  )
  expect(container.textContent).toContain("检查消息渲染")
  expect(container.textContent).not.toContain("private instructions")
})

it("shows waiting for input from existing child activity and clears it when the child resumes", () => {
  render([call], [task])
  act(() =>
    useDesktopSessionStore.setState({
      activity: {
        ...createActivityState(),
        sessions: {
          "child-1": {
            session: emptySessionView("child-1").session,
            executionState: "needs_input",
            attentionState: "read",
            activitySeq: 1,
            updatedAt: 1,
          },
        },
      },
    })
  )
  expect(container.querySelector('[role="status"]:not([aria-hidden="true"])')?.textContent).toBe(
    "等待处理"
  )
  act(() => useDesktopSessionStore.setState({ activity: createActivityState() }))
  expect(container.querySelector('[role="status"]:not([aria-hidden="true"])')?.textContent).toBe(
    "运行中"
  )
})
