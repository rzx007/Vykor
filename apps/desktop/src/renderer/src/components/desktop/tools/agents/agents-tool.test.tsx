// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { AgentsTool } from "./agents-tool"

let root: Root
let container: HTMLDivElement
const openAux = vi.fn(() => new Promise<never>(() => {}))
const closeAux = vi.fn(async () => undefined)
const callbacks = {
  onOpenFile: vi.fn(),
  canOpenReview: false,
  onOpenReview: vi.fn(),
  onOpenTerminal: vi.fn(),
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  openAux.mockClear()
  closeAux.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sessions: {
        onAuxUpdated: () => () => {},
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
