import { expect, it, vi } from "vitest"
const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock("electron", () => ({ ipcRenderer: electron, webUtils: { getPathForFile: vi.fn() } }))
import { desktopAPI } from "../desktop-api"
it("passes the migration freeze to the renderer before acknowledging its final flush", async () => {
  let frozen = false
  desktopAPI.businessData.onFlushRequested(async (freeze) => { frozen = freeze === true })
  electron.on.mock.lastCall![1]({}, "migration", true)
  await vi.waitFor(() => expect(frozen).toBe(true))
})
it("registers the consumer before signalling ready and acknowledges only after persistence settles", async () => {
  let finish!: () => void
  const off = desktopAPI.businessData.onFlushRequested(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  expect(electron.on.mock.invocationCallOrder[0]).toBeLessThan(
    electron.invoke.mock.invocationCallOrder[0]!
  )
  expect(electron.invoke).toHaveBeenCalledWith("business-data:consumer-ready")
  const listener = electron.on.mock.lastCall![1]
  listener({}, "request")
  await Promise.resolve()
  expect(electron.invoke).not.toHaveBeenCalledWith("business-data:flush-ack", "request", true)
  finish()
  await vi.waitFor(() =>
    expect(electron.invoke).toHaveBeenCalledWith("business-data:flush-ack", "request", true)
  )
  off()
  expect(electron.removeListener).toHaveBeenCalledWith("business-data:flush-request", listener)
})
it("returns only a failure acknowledgement without exposing draft errors", async () => {
  desktopAPI.businessData.onFlushRequested(async () => {
    throw new Error("PRIVATE BODY")
  })
  electron.on.mock.lastCall![1]({}, "failed")
  await vi.waitFor(() =>
    expect(electron.invoke).toHaveBeenCalledWith("business-data:flush-ack", "failed", false)
  )
  expect(JSON.stringify(electron.invoke.mock.calls)).not.toContain("PRIVATE BODY")
})
it("restores interaction only on the host export-resumed event and releases its listener", () => {
  let resumed = false
  const off = desktopAPI.businessData.onFlushRequested(async () => {}, () => { resumed = true })
  const listener = electron.on.mock.calls.findLast(([channel]) => channel === "business-data:export-resumed")![1]
  expect(resumed).toBe(false)
  listener({})
  expect(resumed).toBe(true)
  off()
  expect(electron.removeListener).toHaveBeenCalledWith("business-data:export-resumed", listener)
})
