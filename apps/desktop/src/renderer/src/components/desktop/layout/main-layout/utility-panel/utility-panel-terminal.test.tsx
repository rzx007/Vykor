// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"
import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { UtilityPanel } from "./utility-panel"
import { readUtilityPanelRuntimeState } from "./utility-panel-repository"

// 终端的进程和绘制另有测试；这里模拟它向面板报告打开、失败和命令完成。
vi.mock("@renderer/components/desktop/tools/terminal/terminal-tool", async () => {
  const { useEffect } = await import("react")
  return { TerminalTool: (props: {
    openRequest: { id: number; terminalId: string } | null
    command: { id: number; type: string } | null
    onSessionUpsert: (record: { id: string; title: string }, activate: boolean) => void
    onCommandSettled: (id: number) => void
    onOpenRequestSettled?: (id: number) => void
  }) => {
    useEffect(() => {
      if (!props.openRequest) return
      if (props.openRequest.terminalId !== "missing") props.onSessionUpsert({ id: props.openRequest.terminalId, title: "preview" }, true)
      props.onOpenRequestSettled?.(props.openRequest.id)
    }, [props.openRequest?.id])
    useEffect(() => {
      if (props.command) props.onCommandSettled(props.command.id)
    }, [props.command?.id])
    return null
  } }
})

const initialStore = useDesktopSessionStore.getState()
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  useDesktopSessionStore.setState(initialStore, true)
  resetWorkspaceGitProbeCacheForTests()
  useDesktopSessionStore.setState({ selectedProject: null, activeSessionId: "s1", sessionView: {
    ...emptySessionView("s1"), session: { ...emptySessionView("s1").session, cwd: "D:/repo", workspaceMode: "outside_project" },
  } })
  Object.defineProperty(window, "desktop", { configurable: true, value: { git: {
    isRepository: async () => ({ isRepository: false, rootPath: null }),
  } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useDesktopSessionStore.setState(initialStore, true)
  resetWorkspaceGitProbeCacheForTests()
  vi.unstubAllGlobals()
})

function panel(scopeId: string, requestId: number, terminalId = "terminal-1") {
  return createElement(UtilityPanel, {
    scopeId, open: true, maximized: false, onToggleMaximized() {}, onClose() {},
    fileOpenRequest: null, reviewOpenRequest: null, toolOpenRequest: null,
    terminalOpenRequest: { id: requestId, terminalId },
    onOpenFile() {}, onOpenReview() {}, onOpenTerminal() {},
  })
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it("returns to the launcher after closing the only terminal opened from a message", async () => {
  const scopeId = "session:terminal-close-regression"
  await act(async () => root.render(panel(scopeId, 1)))
  await settle()
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭标签"]')
  expect(close).not.toBeNull()
  await act(async () => close!.click())
  await settle()
  expect(readUtilityPanelRuntimeState(scopeId)?.tabs).toEqual([])
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.includes("浏览器"))).toBe(true)
  // 同一个已完成请求不能因为面板重新挂载而重新打开关闭的终端。
  await act(async () => root.unmount())
  root = createRoot(container)
  await act(async () => root.render(panel(scopeId, 1)))
  await settle()
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.includes("浏览器"))).toBe(true)
  expect(readUtilityPanelRuntimeState(scopeId)?.tabs).toEqual([])
  // 用户再次打开时，新请求仍然能打开终端。
  await act(async () => root.render(panel(scopeId, 2)))
  await settle()
  expect(readUtilityPanelRuntimeState(scopeId)?.tabs).toHaveLength(1)
})

it("also releases the pending state when the requested terminal no longer exists", async () => {
  await act(async () => root.render(panel("session:terminal-open-failure", 3, "missing")))
  await settle()
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.includes("浏览器"))).toBe(true)
})
