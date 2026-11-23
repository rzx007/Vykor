import { expect, it, vi } from "vitest"
import { ComputerHost } from "../computer-host"
import type { WindowsAppWindow } from "../windows-apps"

const editor = { id: "editor", name: "Notepad" }
const calc = { id: "calculator", name: "Calculator" }
const root: WindowsAppWindow = {
  windowId: 13, pid: 51, processStartedAt: 1_700_000_000, sessionId: 1, title: "notes.txt - Notepad",
}
const reading = { ...root, windowId: 14 }
const dialog = { ...root, windowId: 15, ownerWindowId: root.windowId, title: "Save As" }
const calculator = { ...root, windowId: 20, pid: 72, title: "Calculator" }

function fixture(isRememberedApp?: (id: string) => boolean) {
  const windows = vi.fn(async (app: typeof editor, _signal: AbortSignal): Promise<WindowsAppWindow[]> =>
    app.id === editor.id ? [root] : [])
  const launch = vi.fn(async (_app: typeof editor, _signal: AbortSignal) => {})
  const discover = vi.fn(async (name: string, _signal: AbortSignal) =>
    [editor, calc].filter(app => app.name === name))
  const authorizeApp = vi.fn(async (_app: typeof editor, _signal: AbortSignal): Promise<boolean | "remembered"> => true)
  const chooseTarget = vi.fn(async (candidates: readonly { id: string; label: string }[], _signal: AbortSignal) => candidates[0]?.id)
  const host = new ComputerHost({ windows, discover, launch }, { authorizeApp, chooseTarget, isRememberedApp })
  const connection = new AbortController()
  const dispatch = vi.fn(async () => true)
  const run = { sessionId: "s", runId: "r", inputId: "i" }
  const open = (app: string, windowHint?: string, signal = connection.signal) =>
    host.execute({ type: "execute", run, requestId: "open", deadlineAt: Date.now() + 5_000,
      action: { type: "open_app", app, windowHint } }, signal, connection.signal, undefined, dispatch)
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

it("reuses a unique named document without launching or asking for a target choice", async () => {
  const f = fixture()
  f.windows.mockResolvedValue([root, { ...reading, title: "unrelated.txt - Notepad" }])
  const opened = await f.open("Notepad", "notes.txt")
  expect(opened).toHaveProperty("text", expect.stringContaining('"source":"reused"'))
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
