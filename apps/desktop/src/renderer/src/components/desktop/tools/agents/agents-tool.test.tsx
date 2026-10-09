// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { AgentsTool } from "./agents-tool"
import type {
  DesktopAuxSessionUpdate,
  DesktopSessionUpdate,
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
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
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
