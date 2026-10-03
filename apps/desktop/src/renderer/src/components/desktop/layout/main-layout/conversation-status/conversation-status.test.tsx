// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionView, InterruptDesktopSessionInput } from "@shared/session-types"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { ConversationStatus } from "./conversation-status"

const initialState = useDesktopSessionStore.getState()
let root: Root
let container: HTMLDivElement

function snapshot(status: "running" | "completed" = "running", id = "run"): DesktopSessionView {
  return {
    cursor: 1,
    syncStatus: "connected",
    session: {
      id: "chat",
      title: "当前聊天",
      cwd: "D:/work",
      model: "test",
      status: status === "running" ? "running" : "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    permissions: [],
    tasks: [],
    runs: [
      {
        id,
        sessionId: "chat",
        inputId: id,
        status,
        startedAt: 1_000,
        ...(status === "completed" ? { finishedAt: 16_000 } : {}),
        metadata: {},
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ],
    messages: [
      {
        id: "message",
        sessionId: "chat",
        role: "assistant",
        runId: id,
        seq: 1,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    parts: [
      {
        id: "text",
        sessionId: "chat",
        messageId: "message",
        seq: 1,
        type: "text",
        text: "检查布局和状态同步。",
        status: "completed",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
  vi.setSystemTime(11_000)
  useDesktopSessionStore.setState(
    { ...initialState, activeSessionId: "chat", sessionView: snapshot(), sessionRuntimes: {} },
    true
  )
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useDesktopSessionStore.setState(initialState, true)
  Reflect.deleteProperty(window, "desktop")
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function render(visible = true) {
  act(() => root.render(<ConversationStatus visible={visible} onRestore={() => {}} />))
}
function region() {
  return container.querySelector('[aria-label="当前会话状态"]')
}
function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

it("only shows while maximized and clears a previous chat snapshot during a switch", () => {
  render(false)
  expect(region()).toBeNull()
  render()
  expect(region()?.textContent).toContain("检查布局和状态同步。")
  act(() => useDesktopSessionStore.setState({ activeSessionId: "other" }))
  expect(region()).toBeNull()
})

it("keeps persisted elapsed time across visibility changes and freezes it on completion", () => {
  render()
  expect(region()?.textContent).toContain("10秒")
  act(() => vi.advanceTimersByTime(5_000))
  expect(region()?.textContent).toContain("15秒")
  render(false)
  act(() => vi.advanceTimersByTime(5_000))
  render()
  expect(region()?.textContent).toContain("20秒")
  act(() => useDesktopSessionStore.setState({ sessionView: snapshot("completed") }))
  expect(region()?.textContent).toContain("已完成")
  expect(region()?.textContent).toContain("15秒")
  act(() => vi.advanceTimersByTime(60_000))
  expect(region()?.textContent).toContain("15秒")
  expect(button("停止当前任务")).toBeNull()
})

it("dismisses only the finished result and shows new work automatically", () => {
  useDesktopSessionStore.setState({ sessionView: snapshot("completed") })
  render()
  expect(button("关闭任务结果提示")).not.toBeNull()
  act(() => button("关闭任务结果提示")!.click())
  expect(region()).toBeNull()
  render(false)
  render()
  expect(region()).toBeNull()
  act(() => useDesktopSessionStore.setState({ sessionView: snapshot("running", "new-run") }))
  expect(region()?.textContent).toContain("处理中")
  expect(button("关闭任务结果提示")).toBeNull()
})

it("restores the conversation through the summary action without stopping the task", () => {
  function Workspace() {
    const [maximized, setMaximized] = useState(true)
    return (
      <>
        <ConversationStatus visible={maximized} onRestore={() => setMaximized(false)} />
        {!maximized && <p>完整聊天</p>}
      </>
    )
  }
  act(() => root.render(<Workspace />))
  act(() => button("返回当前聊天")!.click())
  expect(container.textContent).toBe("完整聊天")
  expect(useDesktopSessionStore.getState().sessionView?.runs[0]?.status).toBe("running")
})

it("uses the existing interrupt action, targets the current run and disables duplicate requests", async () => {
  let finish!: () => void
  const requests: InterruptDesktopSessionInput[] = []
  Object.assign(window, {
    desktop: {
      sessions: {
        interrupt: (input: InterruptDesktopSessionInput) => {
          requests.push(input)
          return new Promise<void>((resolve) => {
            finish = resolve
          })
        },
      },
    },
  })
  render()
  await act(async () => button("停止当前任务")!.click())
  expect(requests).toEqual([{ sessionId: "chat", expectedRunId: "run" }])
  expect(button("停止当前任务")?.disabled).toBe(true)
  await act(async () => button("停止当前任务")!.click())
  expect(requests).toHaveLength(1)
  await act(async () => finish())
  act(() =>
    useDesktopSessionStore.setState({
      sessionView: {
        ...snapshot(),
        runs: [{ ...snapshot().runs[0]!, status: "interrupted", finishedAt: 16_000 }],
      },
    })
  )
  expect(region()?.textContent).toContain("已停止")
  expect(button("停止当前任务")).toBeNull()
})

it("does not let a pending question be dismissed as a completed result", () => {
  const view = snapshot("completed")
  view.permissions = [
    {
      id: "ask",
      sessionId: "chat",
      runId: "run",
      toolName: "AskUser",
      payload: { input: { kind: "question", question: "选哪种布局？" } },
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  useDesktopSessionStore.setState({ sessionView: view })
  render()
  expect(region()?.textContent).toContain("等待回答")
  expect(button("关闭任务结果提示")).toBeNull()
})
