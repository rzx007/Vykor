// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { AgentsTool } from "../agents-tool"
import { instance, sourcePart } from "../../../conversation-page/message/tool-details/__test__/plugin-ui-history-fixture"
import type {
  DesktopAuxSessionUpdate,
  DesktopSessionUpdate,
  DesktopSessionTask,
  DesktopSessionView,
} from "@shared/session-types"

let root: Root
let container: HTMLDivElement
const openAux = vi.fn<() => Promise<DesktopSessionView>>()
const closeAux = vi.fn(async () => undefined)
const acknowledgeUpdate = vi.fn(async () => ({ accepted: true }))
const requestUpdateResync = vi.fn(async () => ({ accepted: true }))
const auxListeners = new Set<(update: DesktopAuxSessionUpdate) => void>()
const callbacks = {
  onOpenFile: vi.fn(),
  canOpenReview: false,
  onOpenReview: vi.fn(),
  onOpenTerminal: vi.fn(),
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  openAux.mockReset()
  openAux.mockImplementation(() => new Promise<never>(() => {}))
  closeAux.mockClear()
  acknowledgeUpdate.mockReset().mockResolvedValue({ accepted: true })
  requestUpdateResync.mockReset().mockResolvedValue({ accepted: true })
  auxListeners.clear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sessions: {
        onAuxUpdated: (listener: (update: DesktopAuxSessionUpdate) => void) => {
          auxListeners.add(listener)
          return () => {
            auxListeners.delete(listener)
          }
        },
        openAux,
        closeAux,
        acknowledgeUpdate,
        requestUpdateResync,
      },
    },
  })
  useDesktopSessionStore.setState({
    activeSessionId: "main",
    sessionView: {
      ...emptySessionView("main"),
      tasks: [
        {
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
        },
      ],
    },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
it.each(["tool-result", "session-sidebar"] as const)("shows a retired %s child card as text only", async (surface) => {
  const child = emptySessionView("child-1")
  const childInstance = { ...instance, sessionId: "child-1", surface }
  child.messages = [
    {
      id: "message",
      sessionId: "child-1",
      seq: 1,
      role: "assistant",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  child.parts = [{ ...sourcePart, sessionId: "child-1", metadata: { pluginUi: childInstance } }]
  openAux.mockResolvedValue(child)
  await act(async () => root.render(<AgentsTool {...callbacks} active openRequest={{ id: 50, taskId: "task-1" }} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(container.textContent).toContain("旧插件界面已停用")
  expect(container.textContent).toContain("原始结果，不应消失")
  expect(container.querySelector("iframe")).toBeNull()
  expect(container.textContent).not.toContain("打开交互")
  expect(container.textContent).not.toContain("在侧栏打开")
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("lists pending and running tasks separately from incomplete and completed work without subscribing to children", async () => {
  const current = useDesktopSessionStore.getState().sessionView!
  const task = current.tasks[0]!
  const tasks: DesktopSessionTask[] = [
    { ...task, id: "pending", description: "等待分析", status: "pending" },
    { ...task, id: "running", description: "正在检查", status: "running" },
    { ...task, id: "failed", description: "分析失败", status: "failed" },
    { ...task, id: "interrupted", description: "检查中断", status: "interrupted" },
    { ...task, id: "stopped", description: "主动停止", status: "stopped" },
    { ...task, id: "completed", description: "分析完成", status: "completed" },
  ]
  useDesktopSessionStore.setState({ sessionView: { ...current, tasks } })
  await act(async () => root.render(<AgentsTool {...callbacks} active />))

  const active = container.querySelector('[aria-label="进行中"]')
  const incomplete = container.querySelector('[aria-label="未完成"]')
  const completed = container.querySelector('[aria-label="已完成"]')
  expect(incomplete).not.toBeNull()
  expect(active?.querySelectorAll("button")).toHaveLength(2)
  expect(active?.textContent).toContain("等待分析")
  expect(active?.textContent).toContain("正在检查")
  expect(incomplete?.querySelectorAll("button")).toHaveLength(3)
  for (const description of ["分析失败", "检查中断", "主动停止"]) {
    expect(incomplete?.textContent ?? "").toContain(description)
    expect(completed?.textContent ?? "").not.toContain(description)
  }
  expect(completed?.querySelectorAll("button")).toHaveLength(1)
  expect(completed?.textContent).toContain("分析完成")
  const stopped = [...incomplete!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("主动停止")
  )!
  expect(stopped.textContent).toContain("已停止")
  expect(stopped.textContent).not.toContain("执行出错")
  expect(openAux).not.toHaveBeenCalled()
  expect(auxListeners.size).toBe(0)
})

it("keeps incomplete-only work visible and omits empty groups and unverified partial-result entries", async () => {
  const current = useDesktopSessionStore.getState().sessionView!
  const task = current.tasks[0]!
  useDesktopSessionStore.setState({
    sessionView: {
      ...current,
      tasks: [
        {
          ...task,
          status: "failed",
          runId: "run-current",
          metadata: {
            childFailure: {
              failureKind: "max_turns",
              partialResult: {
                version: 1,
                childSessionId: task.childSessionId,
                runId: "run-old",
                source: "limit_finalization",
                text: "old report",
                truncated: false,
              },
            },
          },
        },
      ],
    },
  })
  await act(async () => root.render(<AgentsTool {...callbacks} active />))

  expect(container.querySelector('[aria-label="未完成"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="进行中"]')).toBeNull()
  expect(container.querySelector('[aria-label="已完成"]')).toBeNull()
  expect(container.textContent).not.toContain("还没有子智能体")
  expect(container.textContent).not.toContain("查看部分结果")
  expect(openAux).not.toHaveBeenCalled()
})

it("opens a verified partial report through the existing row button and child-session subscription", async () => {
  const current = useDesktopSessionStore.getState().sessionView!
  const reportText = "已检查导入路径，运行结果待确认。"
  useDesktopSessionStore.setState({
    sessionView: {
      ...current,
      tasks: [
        {
          ...current.tasks[0]!,
          status: "failed",
          runId: "run-partial",
          metadata: {
            childFailure: {
              failureKind: "max_turns",
              partialResult: {
                version: 1,
                childSessionId: "child-1",
                runId: "run-partial",
                source: "limit_finalization",
                text: reportText,
                truncated: false,
              },
            },
          },
        },
      ],
    },
  })
  const child = emptySessionView("child-1")
  child.messages = [
    {
      id: "report-message",
      sessionId: "child-1",
      seq: 1,
      role: "assistant",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  child.parts = [
    {
      id: "report-part",
      sessionId: "child-1",
      messageId: "report-message",
      seq: 1,
      type: "text",
      status: "completed",
      text: reportText,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  openAux.mockResolvedValue(child)
  await act(async () => root.render(<AgentsTool {...callbacks} active />))

  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="未完成"] button'),
  ].find((button) => button.textContent?.includes("查看部分结果"))
  expect(row).toBeDefined()
  expect(row!.querySelector("button")).toBeNull()
  expect(row!.textContent).toContain("本次轮次已用完，子任务未完成")
  expect(openAux).not.toHaveBeenCalled()
  await act(async () => row!.click())
  expect(openAux).toHaveBeenCalledExactlyOnceWith({
    subscriptionId: "agents:details",
    sessionId: "child-1",
  })
  expect(auxListeners.size).toBe(1)
  expect(container.textContent).toContain(reportText)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="返回子智能体列表"]')!.click()
  )
  expect(auxListeners.size).toBe(0)
  expect(container.querySelector('[aria-label="未完成"]')?.textContent).toContain("查看部分结果")
})

it("opens the requested agent's existing detail subscription once and allows returning to the list", async () => {
  const request = { id: 1, taskId: "task-1" }
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={request} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(openAux).toHaveBeenCalledWith({ subscriptionId: "agents:details", sessionId: "child-1" })
  expect(container.querySelector('[aria-label="返回子智能体列表"]')).not.toBeNull()
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={{ ...request }} />)
  })
  expect(openAux).toHaveBeenCalledTimes(1)
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="返回子智能体列表"]')!.click()
  })
  expect(container.querySelector('[aria-label="返回子智能体列表"]')).toBeNull()
  expect(openAux).toHaveBeenCalledTimes(1)
})

it("applies and acknowledges a child-session part delta", async () => {
  const initial = emptySessionView("child-1", 1)
  initial.messages.push({
    id: "message-1",
    sessionId: "child-1",
    seq: 1,
    role: "assistant",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  })
  initial.parts.push({
    id: "part-1",
    sessionId: "child-1",
    messageId: "message-1",
    seq: 1,
    type: "text",
    status: "running",
    text: "hello",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  })
  openAux.mockResolvedValueOnce(initial)
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={{ id: 10, taskId: "task-1" }} />)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(auxListeners.size).toBe(1)
  const update: DesktopSessionUpdate = {
    kind: "part-delta",
    subscriptionId: "agents:details",
    generation: 1,
    deliveryId: "child-delivery-1",
    sessionId: "child-1",
    deltas: [{
      seq: 2,
      messageId: "message-1",
      partId: "part-1",
      field: "text",
      delta: " world",
      baseLength: 5,
      createdAt: 2,
    }],
  }
  await act(async () =>
    auxListeners.forEach((listener) =>
      listener({ subscriptionId: "agents:details", update })
    )
  )

  expect(acknowledgeUpdate).toHaveBeenCalledWith({
    subscriptionId: "agents:details",
    generation: 1,
    deliveryId: "child-delivery-1",
    result: "applied",
  })
  expect(container.textContent).toContain("hello world")
})

it("releases hidden agent details and reopens the selected child when visible again", async () => {
  openAux.mockResolvedValue(emptySessionView("child-1"))
  const request = { id: 2, taskId: "task-1" }
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={request} />)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  // Let the effect that handles the open request finish after the first render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(container.querySelector('[aria-label="返回子智能体列表"]')).not.toBeNull()

  await act(async () => {
    root.render(<AgentsTool {...callbacks} active={false} openRequest={request} />)
  })
  expect(closeAux).toHaveBeenCalledWith({ subscriptionId: "agents:details" })
  expect(auxListeners.size).toBe(0)
  expect(container.querySelector('[aria-label="返回子智能体列表"]')).toBeNull()

  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={request} />)
  })
  expect(openAux).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[aria-label="返回子智能体列表"]')).not.toBeNull()
})

it("ignores a detail request that resolves after the panel was hidden", async () => {
  let resolveView!: (view: DesktopSessionView) => void
  openAux.mockImplementationOnce(
    () =>
      new Promise<DesktopSessionView>((resolve) => {
        resolveView = resolve
      })
  )
  const request = { id: 3, taskId: "task-1" }
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={request} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active={false} openRequest={request} />)
  })
  await act(async () => {
    resolveView(emptySessionView("child-1"))
  })

  expect(container.querySelector('[aria-label="返回子智能体列表"]')).toBeNull()
  expect(auxListeners.size).toBe(0)
  await act(async () => {
    root.render(<AgentsTool {...callbacks} active openRequest={request} />)
  })
  expect(container.textContent).toContain("正在加载消息")
  expect(openAux).toHaveBeenCalledTimes(2)
})

it("uses the same budget explanation in details and list while keeping raw errors expandable", async () => {
  const current = useDesktopSessionStore.getState().sessionView!
  const budgetTask = { ...current.tasks[0], runId: "run-A", status: "failed" as const, error: "technical turn limit", metadata: { childFailure: {
    failureKind: "max_turns", partialResult: { version: 1, childSessionId: "child-1", runId: "run-A", source: "limit_finalization", text: "partial report", truncated: false },
  } } }
  useDesktopSessionStore.setState({ sessionView: { ...current, tasks: [budgetTask] } })
  openAux.mockResolvedValue(emptySessionView("child-1"))
  await act(async () => { root.render(<AgentsTool {...callbacks} active openRequest={{ id: 99, taskId: "task-1" }} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(container.textContent).toContain("未完成 · 已达轮次上限")
  expect(container.textContent).toContain("子任务未完成")
  expect(container.textContent).toContain("已保留部分结果")
  expect(container.querySelector('[role="alert"]')?.classList.contains("text-destructive")).toBe(false)
  const trigger = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看原始错误记录"))!
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  await act(async () => trigger.click())
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  expect(container.textContent).toContain("technical turn limit")
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="返回子智能体列表"]')!.click())
  expect(container.textContent).toContain("未完成 · 已达轮次上限")
  expect(container.textContent).not.toContain("technical turn limit")
})
