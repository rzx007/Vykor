import { expect, it, vi } from "vitest"
import type { ComputerApprovalProposal, ComputerBridgeEvent, ComputerResult, ComputerSemanticAction } from "@vykor/server/daemon-host"
import { ComputerHost } from "../computer-host"
import { projectObservation } from "../computer-semantics"
import type { WindowsApp, WindowsAppWindow } from "../windows-apps"
import { WindowsDriverError, WindowsDriverHandoffError, type WindowsDriver, type WindowsDriverElement } from "../windows-driver"

const app: WindowsApp = { id: "native", name: "Notepad" }
const window: WindowsAppWindow = { pid: 7, windowId: 64, sessionId: 1, processStartedAt: 2, title: "Untitled - Notepad" }
const control: WindowsDriverElement = {
  role: "Document", token: "private", identity: "runtime-id", label: "Text editor", value: "", actions: ["set_value"],
}
const destructive: WindowsDriverElement = {
  role: "Button", token: "private-delete", identity: "runtime-delete", label: "Delete entry", actions: ["invoke"],
}
const run = { sessionId: "s", runId: "r", inputId: "i" }

it("retains the current selection and its control when surrounding text fills the observation budget", () => {
  const surroundingText = Array.from({ length: 140 }, (_, i) => ({
    token: String(i), role: "Text", label: `Unrelated description ${i}`, actions: [],
  }))
  const snapshot = projectObservation("display", { title: "Settings", elements: [
    ...surroundingText,
    { token: "scale", role: "ComboBox", label: "Scale", depth: 3, actions: ["expand"] },
    { token: "scale-value", role: "ListItem", label: "100% (Recommended)", depth: 4, selected: true, actions: ["select"] },
  ] })
  expect(snapshot.display.limited).toBe(true)
  expect(snapshot.display.elements.slice(-2)).toMatchObject([
    { label: "Scale", actions: ["invoke"] },
    { label: "100% (Recommended)", selected: true, actions: ["choose"] },
  ])
})

function fixture(remember = false, fullAccess?: true) {
  const connection = new AbortController()
  const windows = vi.fn(async () => [window])
  let elements = [control, destructive]
  const act = vi.fn<WindowsDriver["act"]>(async action => {
    if (action.type === "set_text") elements = [{ ...control, value: action.text }, destructive]
  })
  const close = vi.fn(async () => {})
  const observe = vi.fn<WindowsDriver["observe"]>(async () => ({ title: window.title, elements: elements.map(node => ({ ...node })) }))
  const driver = vi.fn(async (): Promise<WindowsDriver> => ({
    observe, act, close,
  }))
  const publishActivity = vi.fn()
  const chooseTarget = vi.fn<NonNullable<ConstructorParameters<typeof ComputerHost>[1]["chooseTarget"]>>(async () => undefined)
  const host = new ComputerHost({ discover: async () => [app], windows, launch: async () => {} }, {
    authorizeApp: async () => remember ? "remembered" : true, chooseTarget, isRememberedApp: () => remember,
    publishActivity,
  }, driver)
  const approve = vi.fn(async (_proposal: ComputerApprovalProposal) => true)
  const dispatch = vi.fn(async () => true)
  const execute = (action: Extract<ComputerBridgeEvent, { type: "execute" }>["action"]) => host.execute({
    type: "execute", run, requestId: "test", deadlineAt: Date.now() + 20_000, action, fullAccess,
  }, connection.signal, connection.signal, approve, dispatch)
  async function open() {
    await execute({ type: "open_app", app: app.name })
    const observed = await execute({ type: "observe" }) as ComputerResult
    expect(observed.text).not.toContain("private")
    return JSON.parse(observed.text).observation.elements as { ref: string; label: string }[]
  }
  return { host, approve, dispatch, windows, execute, act, observe, close, open, publishActivity, chooseTarget,
    changeElements: (rows: WindowsDriverElement[]) => { elements = rows } }
}

it("keeps an in-flight semantic operation unknown when the user pauses", async () => {
  const f = fixture()
  const [field] = await f.open()
  const started = Promise.withResolvers<void>()
  f.act.mockImplementationOnce(async (_action, signal) => {
    await new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true })
      started.resolve()
    })
    throw new WindowsDriverError("Application response missing", "unknown")
  })
  const operation = f.execute({ type: "set_text", elementRef: field!.ref, text: "note" })
  await started.promise
  expect(f.host.pause(run.sessionId, run.runId)).toBe(true)
  expect(await operation).toMatchObject({ executionState: "unknown" })
})

it("does not read back a different document after writing in the same window", async () => {
  const f = fixture(false, true)
  const [field] = await f.open()
  f.act.mockImplementationOnce(async () => {
    f.windows.mockResolvedValue([{ ...window, title: "Other document - Notepad" }])
    f.changeElements([{ ...control, value: "desired text" }, destructive])
  })

  const result = await f.execute({ type: "set_text", elementRef: field!.ref, text: "desired text" })
  expect(result).toMatchObject({ executionState: "unknown" })
  expect(result).not.toHaveProperty("text")
  expect(f.observe).toHaveBeenCalledTimes(2)
  f.chooseTarget.mockImplementationOnce(async choices => choices[0]?.id)
  expect(await f.execute({ type: "observe" })).toMatchObject({
    status: "observed",
    text: expect.stringContaining("Other document - Notepad"),
  })
})

it("can read back after a title change when the document path stays verified", async () => {
  const f = fixture(false, true)
  const known = { ...window, document: "C:/fixture/document.txt" }
  f.windows.mockResolvedValue([known])
  const [field] = await f.open()
  f.act.mockImplementationOnce(async () => {
    f.windows.mockResolvedValue([{ ...known, title: "Changed title" }])
    f.changeElements([{ ...control, value: "desired text" }])
  })
  expect(await f.execute({ type: "set_text", elementRef: field!.ref, text: "desired text" })).toMatchObject({
    text: expect.stringContaining('"evidence":"field_value"'),
  })
  expect(f.observe.mock.lastCall?.[1]).toEqual({ title: "Changed title" })
  expect(f.chooseTarget).not.toHaveBeenCalled()
})

it("keeps a write uncertain if the surrounding selection changes before readback", async () => {
  const f = fixture(false, true)
  const selected = { role: "ListItem", label: "Current record", identity: "record", token: "record-token", actions: [], selected: true }
  f.changeElements([control, selected])
  const field = (await f.open()).find(row => row.label === control.label)!
  f.act.mockImplementationOnce(async () => {
    f.changeElements([{ ...control, value: "desired text" }, { ...selected, identity: "another-record" }])
  })
  const result = await f.execute({ type: "set_text", elementRef: field.ref, text: "desired text" })
  expect(result).toMatchObject({ executionState: "unknown" })
  expect(result).not.toHaveProperty("text")
})

it("checks the current daemon run before a direct semantic write", async () => {
  const f = fixture(false, true)
  const [field] = await f.open()
  f.dispatch.mockResolvedValueOnce(false)
  expect(await f.execute({ type: "set_text", elementRef: field!.ref, text: "note" })).toMatchObject({ executionState: "not_started" })
  expect(f.approve).not.toHaveBeenCalled()
  expect(f.act).not.toHaveBeenCalled()
})

it("prompts manual takeover if an operation opens a credential screen before readback", async () => {
  const f = fixture()
  const [, button] = await f.open()
  f.act.mockImplementationOnce(async () => {
    f.observe.mockRejectedValueOnce(new WindowsDriverHandoffError())
  })
  expect(await f.execute({ type: "invoke", elementRef: button!.ref })).toMatchObject({ executionState: "unknown" })
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "paused", preview: undefined })
})

it("writes using a fresh native token, verifies field value, and invalidates the previous reference", async () => {
  const f = fixture(false, true)
  const [field] = await f.open()
  const action: ComputerSemanticAction = { type: "set_text", elementRef: field!.ref, text: "one\r\ntwo" }
  const result = await f.execute(action) as ComputerResult
  expect(JSON.parse(result.text)).toMatchObject({ status: "verified", evidence: "field_value" })
  expect(JSON.parse(result.text).observation.elements[0]).toMatchObject({ value: "one\r\ntwo" })
  expect(f.act).toHaveBeenCalledExactlyOnceWith({ type: "set_text", token: "private", text: "one\r\ntwo" }, expect.any(AbortSignal))
  expect(f.approve).not.toHaveBeenCalled()
  expect(await f.execute(action)).toMatchObject({ executionState: "not_started" })
  expect(f.close).toHaveBeenCalledTimes(2)
})

it("requires single-use approval and reports no observable effect as unknown", async () => {
  const f = fixture()
  const [, button] = await f.open()
  const action = { type: "invoke", elementRef: button!.ref } as const
  f.approve.mockImplementationOnce(async () => {
    expect(f.close).toHaveBeenCalledTimes(2)
    expect(f.act).not.toHaveBeenCalled()
    return true
  })
  expect(await f.execute(action)).toMatchObject({ executionState: "unknown" })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.act).toHaveBeenCalledOnce()
  expect(await f.execute(action)).toMatchObject({ executionState: "not_started" })
  expect(f.act).toHaveBeenCalledOnce()
})

it("confirms before changing editor contents in ask mode", async () => {
  const f = fixture()
  f.changeElements([{ ...control, value: "existing note" }])
  const [field] = await f.open()
  f.approve.mockResolvedValueOnce(false)
  expect(await f.execute({ type: "set_text", elementRef: field!.ref, text: "" })).toMatchObject({
    executionState: "not_started",
  })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.act).not.toHaveBeenCalled()
})

it("allows a semantic write when only an unrelated control changes", async () => {
  const f = fixture()
  const [field] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    f.changeElements([control, { ...destructive, label: "Another unrelated label" }])
    return true
  })
  expect(await f.execute({ type: "set_text", elementRef: field!.ref, text: "note" })).toMatchObject({
    text: expect.stringContaining('"evidence":"field_value"'),
  })
  expect(f.act).toHaveBeenCalledOnce()
})

it.each(["invoke", "set_text", "choose"] as const)("refuses approved %s when a separate selected item changes", async type => {
  const f = fixture()
  const selected = { role: "ListItem", label: "Current record", identity: "row", token: "row-token", actions: ["select" as const], selected: true }
  const target = type === "invoke" ? destructive : type === "set_text" ? control
    : { ...selected, label: "Target setting", identity: "choice", selected: false }
  f.changeElements([target, selected])
  const buttons = await f.open()
  const button = buttons.find(row => row.label === target.label)!
  f.approve.mockImplementationOnce(async () => {
    f.changeElements([target, { ...selected, selected: false }])
    return true
  })
  const action = type === "set_text" ? { type, elementRef: button.ref, text: "New note" } : { type, elementRef: button.ref }
  expect(await f.execute(action)).toMatchObject({ executionState: "not_started" })
  expect(f.act).not.toHaveBeenCalled()
})

it("rejects approved writes if the full field changed outside the visible preview", async () => {
  const f = fixture()
  const long = { ...control, value: "same preview", valueTruncated: true, valueDigest: "before" }
  f.changeElements([long])
  const [field] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    f.changeElements([{ ...long, valueDigest: "after" }])
    return true
  })
  expect(await f.execute({ type: "set_text", elementRef: field!.ref, text: "same preview" })).toMatchObject({
    executionState: "not_started",
  })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.act).not.toHaveBeenCalled()
})

it("fails closed if control or window changes while human approval is pending", async () => {
  const f = fixture()
  const [, button] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    f.changeElements([control, { ...destructive, identity: "replacement" }])
    return true
  })
  expect(await f.execute({ type: "invoke", elementRef: button!.ref })).toMatchObject({ executionState: "not_started" })
  expect(f.act).not.toHaveBeenCalled()

  const [, replacement] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    f.windows.mockResolvedValue([ { ...window, processStartedAt: window.processStartedAt + 100 } ])
    return true
  })
  expect(await f.execute({ type: "invoke", elementRef: replacement!.ref })).toMatchObject({ executionState: "not_started" })
  expect(f.act).not.toHaveBeenCalled()
})

it("drops local state on Stop before a late approval can dispatch", async () => {
  const f = fixture()
  const [, button] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    f.host.revoke("s", "r")
    return true
  })
  await expect(f.execute({ type: "invoke", elementRef: button!.ref })).rejects.toMatchObject({ name: "AbortError" })
  expect(f.act).not.toHaveBeenCalled()
})

it("identifies only the live run that uses a revoked remembered app grant", async () => {
  const f = fixture(true)
  const [, button] = await f.open()
  f.approve.mockImplementationOnce(async () => {
    expect(f.host.runUsingRememberedApp("unrelated")).toBeUndefined()
    const revoked = f.host.runUsingRememberedApp(app.id)!
    expect(revoked).toEqual(run)
    f.host.revoke(revoked.sessionId, revoked.runId)
    return true
  })
  await expect(f.execute({ type: "invoke", elementRef: button!.ref })).rejects.toMatchObject({ name: "AbortError" })
  expect(f.act).not.toHaveBeenCalled()
  expect(f.host.runUsingRememberedApp(app.id)).toBeUndefined()
})

it("proves selection and scroll with current values and omits protected controls", async () => {
  const f = fixture()
  const option: WindowsDriverElement = {
    role: "CheckBox", token: "private-option", identity: "option", label: "Wrap lines", checked: false, actions: ["toggle"],
  }
  const pane: WindowsDriverElement = {
    role: "Pane", token: "private-pane", identity: "pane", label: "Notes", verticalScrollPercent: 20, actions: ["scroll"],
  }
  f.changeElements([option, pane, { ...control, protected: true, value: "secret" }])
  const observed = await f.open()
  expect(observed.map(element => element.label)).toEqual(["Wrap lines", "Notes"])
  f.act.mockImplementationOnce(async () => f.changeElements([{ ...option, checked: true }, pane]))
  const selected = await f.execute({ type: "choose", elementRef: observed[0]!.ref }) as ComputerResult
  const selection = JSON.parse(selected.text)
  expect(selection).toMatchObject({ status: "verified", evidence: "selection" })
  expect(selection.observation.elements[0]).toMatchObject({ checked: true })
  expect(f.approve).toHaveBeenCalledOnce()

  f.act.mockImplementationOnce(async () => f.changeElements([{ ...option, checked: true }, { ...pane, verticalScrollPercent: 60 }]))
  const scrolled = await f.execute({ type: "scroll", elementRef: selection.observation.elements[1].ref, direction: "down" }) as ComputerResult
  const scroll = JSON.parse(scrolled.text)
  expect(scroll).toMatchObject({ status: "verified", evidence: "scroll_position" })
  expect(scroll.observation.elements[1]).toMatchObject({ scrollPosition: { vertical: 60 } })
  expect(f.approve).toHaveBeenCalledOnce()
})
