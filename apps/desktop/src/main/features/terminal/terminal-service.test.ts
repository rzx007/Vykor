import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WebContents } from "electron"

const state = vi.hoisted(() => ({ invalidated: undefined as (() => void) | undefined, streams: [] as Array<{ signal: AbortSignal; finish: () => void; emit: (value: unknown) => void }> }))
vi.mock("../session/session-service", () => ({ desktopSessionService: {
  onDaemonInvalidated: (callback: () => void) => { state.invalidated = callback; return () => {} },
  daemonClient: async () => ({ terminals: {
    list: async () => [],
    streamEvents: ({ signal }: { signal: AbortSignal }) => ({ [Symbol.asyncIterator]() {
      let complete = false
      let pending: ((value: IteratorResult<unknown>) => void) | undefined
      state.streams.push({ signal, finish: () => { complete = true; pending?.({ done: true, value: undefined }) }, emit: value => pending?.({ done: false, value }) })
      return { next: () => complete ? Promise.resolve({ done: true, value: undefined }) : new Promise<IteratorResult<unknown>>(resolve => { pending = resolve }) }
    } }),
  } }),
} }))
vi.mock("../settings/desktop-preferences", () => ({ getDesktopPreferences: () => ({}) }))
vi.mock("../settings/runtime-settings-service", () => ({ desktopRuntimeSettingsService: {} }))
vi.mock("../settings/terminal-settings-service", () => ({ desktopTerminalSettingsService: {}, terminalShellFileError: () => null }))
vi.mock("./detect-shells", () => ({ listDetectedTerminalShells: () => [], resolvePreferredTerminalShell: () => undefined }))
import { desktopTerminalService } from "./terminal-service"

function owner() {
  return Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
}
afterEach(async () => { await desktopTerminalService.dispose(); state.streams = [] })
describe("terminal events after daemon replacement", () => {
  it("synchronously aborts the old connection and keeps the replacement subscription when the old pump finishes", async () => {
    const contents = owner()
    await desktopTerminalService.list(contents)
    await vi.waitFor(() => expect(state.streams).toHaveLength(1))
    state.invalidated?.()
    expect(state.streams[0]!.signal.aborted).toBe(true)
    await desktopTerminalService.list(contents)
    await vi.waitFor(() => expect(state.streams).toHaveLength(2))
    state.streams[0]!.finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    await desktopTerminalService.list(contents)
    expect(state.streams).toHaveLength(2)
    state.streams[1]!.emit({ type: "data", terminalId: "new", data: "output" })
    await vi.waitFor(() => expect(contents.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: "output" })))
    state.streams[1]!.finish()
  })
  it("allows a fresh subscription after a stream ends normally", async () => {
    const contents = owner()
    await desktopTerminalService.list(contents)
    await vi.waitFor(() => expect(state.streams).toHaveLength(1))
    state.streams[0]!.finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    await desktopTerminalService.list(contents)
    await vi.waitFor(() => expect(state.streams).toHaveLength(2))
    state.streams[1]!.finish()
  })
})
