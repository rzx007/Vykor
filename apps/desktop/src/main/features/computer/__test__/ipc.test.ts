import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import type { AppContext } from "../../../core/app-context"
import { IpcChannels } from "../../../../shared/ipc-channels"

const service = vi.hoisted(() => ({
  sendComputerPrompt: vi.fn(),
  controlComputer: vi.fn(),
  pauseComputer: vi.fn(),
  revokeComputerRun: vi.fn(),
  invalidateComputerView: vi.fn(),
  subscriptions: {
    getOwnerSessionId: vi.fn(),
    onOwnerInvalidated: vi.fn((_listener: (ownerId: number, change?: { nextSessionId?: string }) => void) => () => {}),
    onOwnerSnapshot: vi.fn(() => () => {}),
  },
}))
vi.mock("../../session/session-service", () => ({ desktopSessionService: service }))
vi.mock("../availability", () => ({ computerAvailability: () => "ready" }))
const shareWindowsPicture = vi.hoisted(() => vi.fn<(window: unknown, signal: AbortSignal) => Promise<{ bytes: Uint8Array } | null>>())
vi.mock("../window-share", () => ({ shareWindowsPicture }))

import { computerIpcContribution } from "../ipc"

function fixture() {
  service.sendComputerPrompt.mockClear()
  service.invalidateComputerView.mockClear()
  service.subscriptions.onOwnerInvalidated.mockClear()
  service.controlComputer.mockReset().mockResolvedValue(true)
  service.subscriptions.getOwnerSessionId.mockReturnValue("session")
  const source = "http://127.0.0.1:5173/"
  const frame = { url: source + "#/" }
  const contents = Object.assign(new EventEmitter(), { id: 8, mainFrame: frame, isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isVisible: () => true, isMinimized: () => false })
  const app = { paths: { rendererUrl: source }, windowManager: { getMain: () => window } }
  const registrations = computerIpcContribution.register(app as unknown as AppContext)
  const [registration] = registrations
  return { registration: registration!, registrations, contents, frame, window }
}

it("rejects a companion, a subframe, and a navigated main document", () => {
  const { registration, contents, frame } = fixture()
  expect(() => registration.handler({ sender: {}, senderFrame: frame } as never, {})).toThrow(/主窗口/)
  expect(() => registration.handler({ sender: contents, senderFrame: { ...frame } } as never, {})).toThrow(/主窗口/)
  frame.url = "https://example.test/"
  expect(() => registration.handler({ sender: contents, senderFrame: frame } as never, {})).toThrow(/主窗口/)
  expect(service.sendComputerPrompt).not.toHaveBeenCalled()
})

it("shares only from the main chat and drops the picture when the user changes chats", async () => {
  const { registrations, contents, frame } = fixture()
  const share = registrations.find(item => item.channel === IpcChannels.computerShareWindow)!.handler
  const captured = Promise.withResolvers<{ bytes: Uint8Array }>()
  shareWindowsPicture.mockReset().mockReturnValue(captured.promise)
  await expect(share({ sender: contents, senderFrame: { ...frame } } as never)).rejects.toThrow(/主窗口/)
  expect(shareWindowsPicture).not.toHaveBeenCalled()

  const request = share({ sender: contents, senderFrame: frame } as never)
  expect(shareWindowsPicture).toHaveBeenCalledOnce()
  const signal = shareWindowsPicture.mock.calls[0]![1]
  service.subscriptions.onOwnerInvalidated.mock.calls[0]![0](contents.id, { nextSessionId: "other" })
  expect(signal.aborted).toBe(true)
  captured.resolve({ bytes: new Uint8Array([1, 2]) })
  await expect(request).resolves.toBeNull()
  expect(service.sendComputerPrompt).not.toHaveBeenCalled()
})

it("revokes the caller scope when the main document leaves and ignores history or subframe navigation", () => {
  const { registration, contents, frame } = fixture()
  const input = { sessionId: "session", id: "input", items: [] }
  registration.handler({ sender: contents, senderFrame: frame } as never, input)
  expect(service.sendComputerPrompt).toHaveBeenCalledExactlyOnceWith(contents, input, expect.any(Function), expect.any(AbortSignal),
    expect.objectContaining({ authorizeApp: expect.any(Function), chooseTarget: expect.any(Function) }))
  const [, , authorize, signal] = service.sendComputerPrompt.mock.calls[0]!
  expect(signal.aborted).toBe(false)
  contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
  expect(signal.aborted).toBe(false)
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
  expect(signal.aborted).toBe(true)
  frame.url = "https://example.test/"
  expect(authorize).toThrow(/主窗口/)
})

it("only accepts controls for the exact run visible to the owning main chat", async () => {
  const { registration, registrations, contents, frame } = fixture()
  const event = { sender: contents, senderFrame: frame } as never
  registration.handler(event, { sessionId: "session", id: "input", items: [] })
  const [, , , , interaction] = service.sendComputerPrompt.mock.calls[0]!
  interaction.publishActivity("session", { runId: "new", phase: "paused" })
  const get = registrations.find(item => item.channel === IpcChannels.computerActivityGet)!.handler
  const control = registrations.find(item => item.channel === IpcChannels.computerControl)!.handler
  expect(get(event, "session")).toMatchObject({ sessionId: "session", runId: "new" })
  expect(control(event, { sessionId: "session", runId: "old", action: "stop" })).toBe(false)
  expect(control(event, { sessionId: "other", runId: "new", action: "resume" })).toBe(false)
  expect(service.controlComputer).not.toHaveBeenCalled()
  const resume = { sessionId: "session", runId: "new", action: "resume" }
  await expect(control(event, resume)).resolves.toBe(true)
  expect(service.controlComputer).toHaveBeenCalledExactlyOnceWith(resume)
  service.subscriptions.getOwnerSessionId.mockReturnValue("other")
  expect(get(event, "session")).toBeNull()
  expect(control(event, resume)).toBe(false)
})

it("revokes a view's Computer submissions on switching or hiding before the first activity arrives", () => {
  const { registration, contents, frame, window } = fixture()
  registration.handler({ sender: contents, senderFrame: frame } as never, { sessionId: "session", id: "input", items: [] })
  const invalidate = service.subscriptions.onOwnerInvalidated.mock.calls[0]?.[0]
  expect(invalidate).toBeTypeOf("function")
  invalidate!(contents.id, { nextSessionId: "other" })
  expect(service.invalidateComputerView).toHaveBeenCalledExactlyOnceWith("other")
  window.emit("hide")
  expect(service.invalidateComputerView).toHaveBeenLastCalledWith(undefined)
})
