import { expect, it, vi } from "vitest"
import type { ComputerBridgeEvent, ComputerResult } from "@vykor/server/daemon-host"
import { ComputerHost } from "../computer-host"
import type { WindowsApps, WindowsAppWindow } from "../windows-apps"
import { WindowsForegroundStartError, type WindowsForeground, type WindowsForegroundFrame, type WindowsForegroundRevokeReason } from "../windows-foreground"

const run = { sessionId: "session", runId: "run", inputId: "input" }
const window: WindowsAppWindow = { windowId: 21, pid: 1, sessionId: 1, processStartedAt: 1, title: "Test Window" }
const secondWindow = { ...window, windowId: 22, title: "Other Window" }
const frame: WindowsForegroundFrame = {
  mimeType: "image/png", data: "aW1hZ2U=", width: 100, height: 80,
  geometry: { left: 0, top: 0, width: 100, height: 80, dpi: 96, monitor: "main" },
  focusIdentity: "1,21,2",
}

function fixture() {
  const connection = new AbortController()
  const emergencyStop = vi.fn()
  const showForeground = vi.fn<(_sessionId: string, _runId: string, _signal: AbortSignal) => Promise<void>>(async () => {})
  const publishActivity = vi.fn()
  const invalidateCapturedImage = vi.fn()
  const perform = vi.fn(async () => ({ state: "sent" as const, released: true }))
  const release = vi.fn(async () => ({ released: true, exited: true }))
  const capture = vi.fn(async () => frame)
  const launch = vi.fn(async () => {})
  const windows = vi.fn<WindowsApps["windows"]>(async app => [app.id === "Second" ? secondWindow : window])
  let lost: undefined | ((reason: WindowsForegroundRevokeReason) => void)
  const enter = vi.fn<WindowsForeground["enter"]>(async (_window, onRevoked) => {
    lost = onRevoked
    return { perform, release }
  })
  const host = new ComputerHost({
    discover: async name => [{ id: name, name }], windows,
    launch,
  }, {
    authorizeApp: async () => true, chooseTarget: async () => undefined, emergencyStop, showForeground, publishActivity, invalidateCapturedImage,
  }, undefined, { capture, enter })
  const approve = vi.fn(async () => true)
  const dispatch = vi.fn(async () => true)
  const execute = (action: Extract<ComputerBridgeEvent, { type: "execute" }>["action"], controller = connection) => host.execute({
    type: "execute", requestId: "operation", run, action, deadlineAt: Date.now() + 5000,
  }, controller.signal, connection.signal, approve, dispatch)
  const snapshot = async () => {
    const result = await execute({ type: "capture" }) as ComputerResult
    return { result, ref: JSON.parse(result.text).frame.ref as string }
  }
  return { approve, emergencyStop, showForeground, capture, dispatch, enter, execute, host, perform, publishActivity, release, windows, launch, invalidateCapturedImage,
    loseFocus: () => lost?.("focus_lost"), pressEscape: () => lost?.("emergency_stop"), snapshot }
}

it("makes a window image available only for capture and guards a coordinate with a fresh frame", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  const { result, ref } = await f.snapshot()
  expect(result.image).toMatchObject({ mediaType: "image/png", data: frame.data, width: frame.width })
  expect(result.text).not.toContain(frame.data)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ runId: run.runId, preview: { dataUrl: `data:image/png;base64,${frame.data}` } })
  expect(await f.execute({ type: "click", frameRef: ref, x: 20, y: 30 })).toMatchObject({ executionState: "not_started" })
  expect(f.perform).not.toHaveBeenCalled()
  await f.execute({ type: "foreground" })
  expect(f.approve).toHaveBeenCalledOnce()
  expect(f.dispatch).toHaveBeenCalledTimes(2)
  const latest = await f.snapshot()
  expect(await f.execute({ type: "click", frameRef: ref, x: 20, y: 30 })).toMatchObject({ executionState: "not_started" })
  const clicked = await f.execute({ type: "click", frameRef: latest.ref, x: 20, y: 30 }) as ComputerResult
  expect(JSON.parse(clicked.text)).toMatchObject({ status: "sent", inputReleased: true })
  expect(f.perform).toHaveBeenCalledExactlyOnceWith({ type: "click", x: 20, y: 30 }, frame, expect.any(AbortSignal))
  expect(f.approve).toHaveBeenCalledTimes(2)
  expect(f.dispatch).toHaveBeenCalledTimes(3)
})

it("captures the result without acquiring input or revealing a preview or coordinate reference", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  const result = await f.execute({ type: "capture", purpose: "result" }) as ComputerResult
  const reply = JSON.parse(result.text)
  expect(reply).toMatchObject({ status: "captured" })
  expect(reply.frame).toBeUndefined()
  expect(result.image).toMatchObject({ data: frame.data })
  expect(f.publishActivity.mock.lastCall?.[1]?.preview).toBeUndefined()
  expect(f.enter).not.toHaveBeenCalled()
})

it("releases on focus loss, parks further work, and requires a new occupation and observation", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  const { ref } = await f.snapshot()
  f.loseFocus()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "paused" })
  const staleClick = f.execute({ type: "click", frameRef: ref, x: 3, y: 4 })
  await expect(f.host.resume(run.sessionId, "wrong")).resolves.toBe(false)
  expect(f.perform).not.toHaveBeenCalled()
  await expect(f.host.resume(run.sessionId, run.runId)).resolves.toBe(true)
  expect(await staleClick).toMatchObject({ executionState: "not_started" })
  expect(f.perform).not.toHaveBeenCalled()
  await f.execute({ type: "foreground" })
  expect(f.enter).toHaveBeenCalledTimes(2)
  expect(await f.execute({ type: "key", key: "Tab" })).toMatchObject({ executionState: "not_started" })
})

it("stops input and interrupts the original run when the OS reports Escape", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  f.pressEscape()
  f.pressEscape()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.emergencyStop).toHaveBeenCalledExactlyOnceWith(run.sessionId, run.runId)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "stopped" })
  expect(await f.execute({ type: "key", key: "Tab" })).toMatchObject({ executionState: "not_started" })
  expect(f.perform).not.toHaveBeenCalled()
})

it.each(["ready", "stop", "unavailable"] as const)("waits for the foreground notice before accepting input (%s)", async outcome => {
  const f = fixture()
  const notice = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  f.showForeground.mockImplementationOnce((_session, _run, signal) => {
    signal.addEventListener("abort", () => notice.reject(signal.reason), { once: true })
    waiting.resolve()
    return notice.promise
  })
  await f.execute({ type: "open_app", app: "First" })
  const foreground = f.execute({ type: "foreground" })
  await Promise.race([waiting.promise, foreground])
  expect(f.showForeground).toHaveBeenCalledOnce()
  expect(f.publishActivity.mock.lastCall?.[1]?.phase).not.toBe("foreground")
  expect(f.perform).not.toHaveBeenCalled()
  if (outcome === "stop") {
    f.pressEscape()
    await expect(foreground).rejects.toThrow()
    expect(f.release).toHaveBeenCalledOnce()
  } else if (outcome === "unavailable") {
    notice.reject(new Error("overlay could not open"))
    expect(await foreground).toMatchObject({ error: "无法显示前台控制提示，键鼠输入未派发。", executionState: "not_started" })
    expect(f.release).toHaveBeenCalledOnce()
  } else {
    notice.resolve()
    expect(await foreground).toHaveProperty("text", expect.stringContaining('"status":"foreground"'))
    expect(f.publishActivity.mock.lastCall?.[1]?.phase).toBe("foreground")
  }
})

it("yields the keyboard and mouse to Browser and requires a fresh window frame on return", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  const { ref } = await f.snapshot()
  await expect(f.host.yieldInputToBrowser("different-session")).resolves.toBe(true)
  expect(f.release).not.toHaveBeenCalled()

  const release = Promise.withResolvers<{ released: boolean; exited: boolean }>()
  f.release.mockReturnValueOnce(release.promise)
  const yielded = f.host.yieldInputToBrowser(run.sessionId)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.publishActivity.mock.lastCall?.[1]?.preview).toBeUndefined()
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ inputRelease: "pending" })
  release.resolve({ released: true, exited: true })
  await expect(yielded).resolves.toBe(true)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "ready", evidence: "键鼠已释放。" })
  expect(await f.execute({ type: "key", key: "Tab" })).toMatchObject({ executionState: "not_started" })
  await f.execute({ type: "foreground" })
  expect(await f.execute({ type: "click", frameRef: ref, x: 3, y: 4 })).toMatchObject({ executionState: "not_started" })
  expect(f.perform).not.toHaveBeenCalled()
})

it("retires input and images on switch, pause, capture opt-out, and Stop", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  await f.snapshot()
  expect(f.host.setCaptureEnabled(run.sessionId, false, run.runId)).toBe(true)
  expect(f.invalidateCapturedImage).toHaveBeenCalledWith(run.sessionId, run.runId)
  expect(f.publishActivity.mock.lastCall?.[1]?.preview).toBeUndefined()
  expect(await f.execute({ type: "capture" })).toMatchObject({ executionState: "not_started" })
  expect(f.capture).toHaveBeenCalledOnce()
  await f.execute({ type: "open_app", app: "Second" })
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ app: "Second", phase: "ready" })
  expect(await f.execute({ type: "key", key: "Tab" })).toMatchObject({ executionState: "not_started" })
  await f.execute({ type: "foreground" })
  expect(f.host.pause(run.sessionId, run.runId)).toBe(true)
  expect(f.release).toHaveBeenCalledTimes(2)
  await f.host.resume(run.sessionId, run.runId)
  await f.execute({ type: "foreground" })
  f.host.revoke(run.sessionId, "wrong")
  expect(f.release).toHaveBeenCalledTimes(2)
  f.host.revoke(run.sessionId, run.runId)
  expect(f.release).toHaveBeenCalledTimes(3)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "stopped" })
})

it("keeps a task paused if the user leaves while resume is rechecking the window", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  f.host.pause(run.sessionId, run.runId)
  const verification = Promise.withResolvers<WindowsAppWindow[]>()
  const started = Promise.withResolvers<void>()
  f.windows.mockImplementationOnce(() => { started.resolve(); return verification.promise })
  const resuming = f.host.resume(run.sessionId, run.runId)
  await started.promise
  f.host.pause(run.sessionId, run.runId)
  verification.resolve([window])
  expect(await resuming).toBe(false)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ phase: "paused" })
})

it("drops the old window preview when observation follows an owned dialog", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.snapshot()
  f.windows.mockResolvedValue([window, { ...secondWindow, ownerWindowId: window.windowId }])
  await f.execute({ type: "observe" })
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({ title: secondWindow.title })
  expect(f.publishActivity.mock.lastCall?.[1]?.preview).toBeUndefined()
})

it("rejects a stale screenshot for a key even when no extra approval is required", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  await f.snapshot()
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000)
  try {
    expect(await f.execute({ type: "key", key: "Tab" })).toMatchObject({ executionState: "not_started" })
    expect(f.perform).not.toHaveBeenCalled()
  } finally {
    now.mockRestore()
  }
})

it.each([{ data: "Y2hhbmdlZA==" }, { focusIdentity: "1,21,3" }])("refuses an approved key if the observed content or focus changed (%j)", async change => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  await f.snapshot()
  f.capture.mockResolvedValueOnce({ ...frame, ...change })
  expect(await f.execute({ type: "key", key: "Enter" })).toMatchObject({ executionState: "not_started" })
  expect(f.approve).toHaveBeenCalledTimes(2)
  expect(f.perform).not.toHaveBeenCalled()
})

it("keeps pause pending until key release and daemon capture revocation are acknowledged", async () => {
  const f = fixture()
  await f.execute({ type: "open_app", app: "First" })
  await f.execute({ type: "foreground" })
  await f.snapshot()
  const release = Promise.withResolvers<{ released: boolean; exited: boolean }>()
  const revocation = Promise.withResolvers<boolean>()
  f.release.mockImplementationOnce(() => release.promise)
  f.invalidateCapturedImage.mockReturnValueOnce(revocation.promise)
  expect(f.host.pause(run.sessionId, run.runId)).toBe(true)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({
    phase: "paused", inputRelease: "pending", captureRevocation: "pending", preview: undefined,
  })
  const resuming = f.host.resume(run.sessionId, run.runId)
  release.resolve({ released: true, exited: true })
  await vi.waitFor(() => expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({
    phase: "paused", inputRelease: undefined, captureRevocation: "pending",
  }))
  revocation.resolve(true)
  expect(await resuming).toBe(true)
  expect(f.publishActivity.mock.lastCall?.[1]).toMatchObject({
    phase: "ready", inputRelease: undefined, captureRevocation: undefined,
  })
})

it("does not report not_started if paused after application launch began", async () => {
  const f = fixture()
  const began = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  f.windows.mockResolvedValue([])
  f.launch.mockImplementationOnce(() => { began.resolve(); return finish.promise })
  const opening = f.execute({ type: "open_app", app: "First" })
  await began.promise
  expect(f.host.pause(run.sessionId, run.runId)).toBe(true)
  finish.resolve()
  expect(await opening).toMatchObject({ executionState: "unknown" })
})

it("retains unknown input release when a foreground startup is cancelled before it returns a lease", async () => {
  const f = fixture()
  const began = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<Awaited<ReturnType<WindowsForeground["enter"]>>>()
  f.enter.mockImplementationOnce(() => { began.resolve(); return entered.promise })
  await f.execute({ type: "open_app", app: "First" })
  const opening = f.execute({ type: "foreground" })
  await began.promise
  expect(f.host.pause(run.sessionId, run.runId)).toBe(true)
  entered.reject(new WindowsForegroundStartError("aborted", { released: false, exited: false }))
  await opening
  expect(await f.host.waitForInputRelease()).toBe(false)
  expect(await f.host.resume(run.sessionId, run.runId)).toBe(false)
})
