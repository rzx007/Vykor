import { expect, it, vi } from "vitest"
import { ComputerHost } from "../computer-host"
import type { ComputerApp } from "../computer-platform"
import type { WindowsAppWindow } from "../windows-apps"
import { sameWindowsWindowInstance } from "../windows-computer-platform"

const editor = { id: "editor", name: "Notepad" }
const calc = { id: "calculator", name: "Calculator" }
const root: WindowsAppWindow = {
  windowId: 13, pid: 51, processStartedAt: 1_700_000_000, sessionId: 1, title: "notes.txt - Notepad",
}
const reading = { ...root, windowId: 14 }
const dialog = { ...root, windowId: 15, ownerWindowId: root.windowId, title: "Save As" }
const calculator = { ...root, windowId: 20, pid: 72, title: "Calculator" }

it("uses the platform's window identity to reject a document in a recycled window", async () => {
  const app = { id: "editor", name: "Editor" }
  const window = { windowId: "editor-window", title: "Notes", instance: "one" }
  const windows = vi.fn(async () => [window])
  const host = new ComputerHost({
    apps: { discover: async () => [app], windows, launch: async () => {} },
    sameWindowInstance: (expected: typeof window, actual: typeof window) =>
      expected.windowId === actual.windowId && expected.instance === actual.instance,
  }, { authorizeApp: async () => true, chooseTarget: async () => undefined })
  const run = { sessionId: "session", runId: "run", inputId: "input" }
  const signal = new AbortController().signal
  const event = { type: "execute" as const, run, requestId: "request", deadlineAt: Date.now() + 5_000 }

  expect(await host.execute({ ...event, action: { type: "open_app", app: app.name } }, signal, signal, undefined, async () => true))
    .toHaveProperty("text", expect.stringContaining("Notes"))
  windows.mockResolvedValue([{ ...window, instance: "two" }])
  expect(await host.execute({ ...event, action: { type: "observe" } }, signal, signal))
    .toMatchObject({ executionState: "not_started" })
})

function fixture(isRememberedApp?: (id: string) => boolean) {
  const windows = vi.fn(async (app: typeof editor, _signal: AbortSignal): Promise<WindowsAppWindow[]> =>
    app.id === editor.id ? [root] : [])
  const launch = vi.fn(async (_app: typeof editor, _signal: AbortSignal) => {})
  const discover = vi.fn(async (name: string, _signal: AbortSignal): Promise<ComputerApp[]> =>
    [editor, calc].filter(app => app.name === name))
  const authorizeApp = vi.fn(async (_app: typeof editor, _signal: AbortSignal): Promise<boolean | "remembered"> => true)
  const chooseTarget = vi.fn(async (candidates: readonly { id: string; label: string }[], _signal: AbortSignal): Promise<string | undefined> => candidates[0]?.id)
  const host = new ComputerHost({
    apps: { catalogName: "开始菜单", windows, discover, launch },
    sameWindowInstance: sameWindowsWindowInstance,
  }, { authorizeApp, chooseTarget, isRememberedApp })
  const connection = new AbortController()
  const dispatch = vi.fn(async () => true)
  const run = { sessionId: "s", runId: "r", inputId: "i" }
  const open = (app: string, windowHint?: string, signal = connection.signal, newWindow?: true) =>
    host.execute({ type: "execute", run, requestId: "open", deadlineAt: Date.now() + 5_000,
      action: { type: "open_app", app, windowHint, newWindow } }, signal, connection.signal, undefined, dispatch)
  const observe = (scope = run, generation = connection.signal) =>
    host.execute({ type: "execute", run: scope, requestId: "observe", deadlineAt: Date.now() + 5_000,
      action: { type: "observe" } }, generation, generation)
  return { windows, launch, discover, authorizeApp, chooseTarget, connection, run, open, observe, dispatch }
}

it("does not launch after the daemon withdrew the run permission", async () => {
  const f = fixture()
  f.dispatch.mockResolvedValueOnce(false)
  expect(await f.open("Calculator")).toMatchObject({ executionState: "not_started" })
  expect(f.launch).not.toHaveBeenCalled()
})

it("uses the platform's application catalog in the lookup error", async () => {
  const f = fixture()
  expect(await f.open("Missing")).toMatchObject({ error: expect.stringContaining("开始菜单"), executionState: "not_started" })
  expect(f.launch).not.toHaveBeenCalled()
})

it("observes a window that appeared after an uncertain launch without launching again", async () => {
  const f = fixture()
  f.launch.mockRejectedValueOnce(new Error("launch reply lost"))
  expect(await f.open("Calculator")).toMatchObject({ executionState: "unknown" })
  f.windows.mockResolvedValue([calculator])
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining("Calculator"))
  expect(f.launch).toHaveBeenCalledOnce()
  expect(f.authorizeApp).toHaveBeenCalledOnce()
})

it("binds a unique fresh window after launching a registered shortcut with parameters", async () => {
  const f = fixture()
  f.discover.mockResolvedValue([{ ...editor, confirmExistingWindow: true }])
  f.windows.mockResolvedValue([])
  f.launch.mockImplementationOnce(async () => { f.windows.mockResolvedValue([root]) })
  expect(await f.open("Notepad")).toHaveProperty("text", expect.stringContaining('"source":"launched"'))
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("binds only a new window after an explicit launch, even if a running window changes its title", async () => {
  const f = fixture()
  f.launch.mockImplementation(async () => {
    f.windows.mockResolvedValue([{ ...root, title: "Retitled existing window" }, { ...reading, title: "New document" }])
  })
  const opened = await f.open("Notepad", undefined, undefined, true)
  expect(opened).toHaveProperty("text", expect.stringContaining('"title":"New document"'))
  expect(opened).toHaveProperty("text", expect.stringContaining('"source":"launched"'))
  expect(f.launch).toHaveBeenCalledOnce()
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("excludes prior windows from observation after an uncertain new-window launch", async () => {
  const f = fixture()
  f.launch.mockRejectedValueOnce(new Error("launch reply lost"))
  expect(await f.open("Notepad", undefined, undefined, true)).toMatchObject({ executionState: "unknown" })
  f.windows.mockResolvedValue([{ ...root, title: "Retitled existing window" }])
  expect(await f.observe()).toMatchObject({ executionState: "not_started" })
  f.windows.mockResolvedValue([root, { ...reading, title: "New document" }])
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining('"title":"New document"'))
  expect(f.launch).toHaveBeenCalledOnce()
})

it("confirms an existing window that Windows cannot attribute to a parameterized shortcut", async () => {
  const f = fixture()
  f.discover.mockResolvedValue([{ ...editor, confirmExistingWindow: true }])
  expect(await f.open("Notepad")).toHaveProperty("text")
  expect(f.chooseTarget).toHaveBeenCalledWith([expect.objectContaining({ label: root.title })],
    expect.any(AbortSignal), f.run.sessionId, true)
  expect(f.launch).not.toHaveBeenCalled()
})

it("observes a retitled instance again and excludes a different document in that window", async () => {
  const f = fixture()
  f.windows.mockResolvedValue([{ ...root, document: "D:/notes.txt" }])
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.windows.mockResolvedValue([{ ...root, title: "Notes saved - Notepad", document: "D:/other.txt" }])
  expect(await f.observe()).toMatchObject({ executionState: "not_started" })
  f.windows.mockResolvedValue([{ ...root, title: "Notes saved - Notepad", document: "D:/notes.txt" }])
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining("Notes saved - Notepad"))
  expect(f.launch).not.toHaveBeenCalled()
})

it("asks before observing a retitled window when Windows cannot establish document identity", async () => {
  const f = fixture()
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.windows.mockResolvedValue([{ ...root, title: "Another document - Notepad" }])
  f.chooseTarget.mockResolvedValueOnce(undefined)
  expect(await f.observe()).toMatchObject({ executionState: "not_started" })
  expect(f.chooseTarget).toHaveBeenCalledExactlyOnceWith(
    [expect.objectContaining({ label: "Another document - Notepad" })], expect.any(AbortSignal), f.run.sessionId, true,
  )
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining("Another document - Notepad"))
  expect(f.launch).not.toHaveBeenCalled()
})

it("reuses a unique named document without launching or asking for a target choice", async () => {
  const f = fixture()
  f.windows.mockResolvedValue([root, { ...reading, title: "unrelated.txt - Notepad" }])
  const opened = await f.open("Notepad", "notes.txt")
  expect(opened).toHaveProperty("text", expect.stringContaining('"source":"reused"'))
  expect(opened).toHaveProperty("text", expect.stringContaining('"next":{"action":"observe"}'))
  expect(opened).toHaveProperty("text", expect.stringContaining('"title":"notes.txt - Notepad"'))
  expect(opened).not.toHaveProperty("text", expect.stringContaining('"pid"'))
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.chooseTarget).not.toHaveBeenCalled()
  expect(f.authorizeApp).toHaveBeenCalledTimes(1)
  expect((await f.observe())).toHaveProperty("text", expect.stringContaining('"kind":"window"'))
})

it("authorizes a new application before launch and drops the previous observation after switching", async () => {
  const f = fixture()
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.authorizeApp.mockResolvedValueOnce(false)
  expect(await f.open("Calculator")).toMatchObject({ executionState: "not_started" })
  expect(f.launch).not.toHaveBeenCalled()
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining("Notepad"))

  f.launch.mockImplementation(async () => { f.windows.mockResolvedValue([calculator]) })
  const switched = await f.open("Calculator")
  expect(switched).toHaveProperty("text", expect.stringContaining('"source":"launched"'))
  expect(f.launch).toHaveBeenCalledExactlyOnceWith(calc, expect.any(AbortSignal))
  expect(f.authorizeApp.mock.invocationCallOrder.at(-1)).toBeLessThan(f.launch.mock.invocationCallOrder[0]!)
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining("Calculator"))
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("asks for a choice only for multiple matching windows and verifies the selected identity again", async () => {
  const f = fixture()
  f.windows.mockResolvedValue([root, reading])
  f.chooseTarget.mockImplementationOnce(async candidates => {
    expect(candidates.map(candidate => candidate.label)).toEqual([root.title, reading.title])
    f.windows.mockResolvedValue([root, { ...reading, processStartedAt: reading.processStartedAt + 1 }])
    return candidates[1]?.id
  })
  expect(await f.open("Notepad", "notes.txt")).toMatchObject({ executionState: "not_started" })
  expect(f.chooseTarget).toHaveBeenCalledTimes(1)
  expect(f.launch).not.toHaveBeenCalled()
})

it("follows a verified owned modal and returns to its parent without another application prompt", async () => {
  const f = fixture()
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.windows.mockResolvedValue([root, dialog, { ...dialog, windowId: 24, ownerWindowId: 99, title: "Foreign dialog" }])
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining('"title":"Save As"'))
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining('"kind":"dialog"'))
  f.windows.mockResolvedValue([root])
  expect(await f.observe()).toHaveProperty("text", expect.stringContaining('"kind":"window"'))
  expect(f.authorizeApp).toHaveBeenCalledTimes(1)
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("pauses on a blocked parent and does not retarget a similarly named window", async () => {
  const f = fixture()
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.windows.mockResolvedValue([{ ...root, blocked: true }, reading])
  expect(await f.observe()).toMatchObject({ error: expect.stringContaining("阻挡"), executionState: "not_started" })
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("requires fresh consent when a remembered application grant is revoked", async () => {
  const remembered = vi.fn(() => true)
  const f = fixture(remembered)
  f.authorizeApp.mockResolvedValueOnce("remembered")
  expect(await f.open("Notepad")).toHaveProperty("text")
  remembered.mockReturnValue(false)
  const before = f.windows.mock.calls.length
  expect(await f.observe()).toMatchObject({ error: expect.stringContaining("撤销"), executionState: "not_started" })
  expect(f.windows).toHaveBeenCalledTimes(before)
  expect(await f.open("Notepad")).toHaveProperty("text")
  expect(f.authorizeApp).toHaveBeenCalledTimes(2)
})

it("will not fall back to a different document, run, or connection", async () => {
  const f = fixture()
  expect(await f.open("Notepad")).toHaveProperty("text")
  f.windows.mockResolvedValue([root, reading])
  expect(await f.open("Notepad", "missing.txt")).toMatchObject({ executionState: "not_started" })
  expect(f.launch).not.toHaveBeenCalled()
  f.connection.abort()
  const other = new AbortController().signal
  expect(await f.observe(f.run, other)).toMatchObject({ executionState: "not_started" })
  expect(await f.observe({ ...f.run, runId: "new" }, other)).toMatchObject({ executionState: "not_started" })
  expect(f.chooseTarget).not.toHaveBeenCalled()
})
