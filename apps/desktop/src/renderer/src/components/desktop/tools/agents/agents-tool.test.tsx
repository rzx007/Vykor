// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { AgentsTool } from "./agents-tool"
import type { DesktopAuxSessionUpdate, DesktopSessionView } from "@shared/session-types"

let root: Root
let container: HTMLDivElement
const openAux = vi.fn<() => Promise<DesktopSessionView>>()
const closeAux = vi.fn(async () => undefined)
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
