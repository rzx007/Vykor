import { expect, it, vi } from "vitest"
const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock("electron", () => ({ ipcRenderer: electron, webUtils: { getPathForFile: vi.fn() } }))
import { desktopAPI } from "../desktop-api"
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
