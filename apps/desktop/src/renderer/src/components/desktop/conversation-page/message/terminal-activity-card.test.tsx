// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopTerminalEvent, DesktopTerminalRecord } from "@shared/terminal-types"
import { TerminalActivityCard } from "./terminal-activity-card"

const terminal: DesktopTerminalRecord = {
  id: "terminal-1", name: "site preview", command: "pnpm dev", cwd: "/repo", shell: "/bin/sh",
  scope: { kind: "session", sessionId: "session-1" }, sessionId: "session-1", source: "agent",
  runtime: "local", status: "running", cols: 80, rows: 24, createdAt: "2026-10-11T00:00:00Z",
}
let root: Root
let container: HTMLDivElement
let records: DesktopTerminalRecord[]
let listeners: Set<(event: DesktopTerminalEvent) => void>
let kill: ReturnType<typeof vi.fn>
let list: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  records = [terminal]
  listeners = new Set()
  list = vi.fn(async () => records)
  kill = vi.fn(async () => {
    records = [{ ...terminal, status: "killed", exitCode: 0 }]
    for (const listener of listeners) listener({ type: "status", terminalId: terminal.id, status: "killed" })
    for (const listener of listeners) listener({ type: "exit", terminalId: terminal.id, exitCode: 0 })
  })
  vi.stubGlobal("desktop", { terminal: {
    list,
    kill,
    onEvent: (listener: (event: DesktopTerminalEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(<TerminalActivityCard terminal={terminal} active={false} onOpenTerminal={() => {}} />))
}

it("shows current exit state instead of the running snapshot in tool history", async () => {
  records = [{ ...terminal, status: "failed", exitCode: 1 }]
  await render()
  expect(container.textContent).toContain("异常退出")
  expect(container.textContent).toContain("pnpm dev")
  expect(container.textContent).not.toContain("停止服务")
})

it("updates a running service when its process exits and ignores other terminals", async () => {
  await render()
  expect(container.textContent).toContain("运行中")
  await act(async () => {
    for (const listener of listeners) listener({ type: "exit", terminalId: "other", exitCode: 1 })
  })
  expect(container.textContent).toContain("运行中")
  await act(async () => {
    for (const listener of listeners) listener({ type: "exit", terminalId: terminal.id, exitCode: 0 })
  })
  expect(container.textContent).toContain("已结束")
  expect(container.textContent).not.toContain("停止服务")
})

it("stops the service and keeps its terminal entry for reading logs", async () => {
  await render()
  const stop = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("停止服务"))!
  expect(stop).toBeDefined()
  await act(async () => stop.click())
  expect(kill).toHaveBeenCalledWith(terminal.id)
  expect(container.textContent).toContain("已停止")
  expect(container.textContent).toContain("打开终端")
})

it("marks a terminal lost after daemon restart as unavailable", async () => {
  records = []
  await render()
  expect(container.textContent).toContain("终端已不可用")
  expect(container.textContent).not.toContain("运行中")
  expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("打开终端"))?.disabled).toBe(true)
})

it("does not overwrite a newer exit event with an older list response", async () => {
  let resolve!: (value: DesktopTerminalRecord[]) => void
  list.mockImplementationOnce(() => new Promise<DesktopTerminalRecord[]>(done => { resolve = done }))
  await render()
  await act(async () => {
    for (const listener of listeners) listener({ type: "exit", terminalId: terminal.id, exitCode: 1 })
    resolve([terminal])
  })
  expect(container.textContent).toContain("异常退出")
  expect(container.textContent).not.toContain("停止服务")
})

it("shows stop failures while keeping the live service available", async () => {
  kill.mockRejectedValueOnce(new Error("cannot stop process"))
  await render()
  const stop = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("停止服务"))!
  await act(async () => stop.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot stop process")
  expect(container.textContent).toContain("运行中")
  expect(stop.disabled).toBe(false)
})
