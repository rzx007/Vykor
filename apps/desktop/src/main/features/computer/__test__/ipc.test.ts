import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import type { AppContext } from "../../../core/app-context"
import { IpcChannels } from "../../../../shared/ipc-channels"

const service = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  sendComputerPrompt: vi.fn(),
  controlComputer: vi.fn(),
  pauseComputer: vi.fn(),
  revokeComputerRun: vi.fn(),
  disconnectComputer: vi.fn(async (): Promise<boolean> => true),
  invalidateComputerView: vi.fn(),
  subscriptions: {
    getOwnerSessionId: vi.fn(),
    getOwnerSessionRecord: vi.fn(),
    onOwnerInvalidated: vi.fn((_listener: (ownerId: number, change?: { nextSessionId?: string }) => void) => () => {}),
    onOwnerSnapshot: vi.fn(() => () => {}),
  },
}))
vi.mock("../../session/session-service", () => ({ desktopSessionService: service }))
const preferences = vi.hoisted(() => ({ computerEnabled: true, computerAlwaysForeground: false }))
vi.mock("../../settings/desktop-preferences", () => ({
  getDesktopPreferences: () => ({ ...preferences, computerAppGrants: [] }),
  patchDesktopPreferences: (patch: Partial<typeof preferences>) => Object.assign(preferences, patch),
}))
const computerAvailability = vi.hoisted(() => vi.fn(async () => "ready"))
vi.mock("../availability", () => ({
  computerAvailability,
  computerDriverAvailability: computerAvailability,
  computerPlatformAvailability: () => preferences.computerEnabled ? "enabled" : "disabled",
  computerSettingsPolicy: () => ({
    enabled: preferences.computerEnabled, alwaysForeground: preferences.computerAlwaysForeground,
  }),
}))
const shareWindowsPicture = vi.hoisted(() => vi.fn<(window: unknown, signal: AbortSignal) => Promise<{ bytes: Uint8Array } | null>>())
vi.mock("../window-share", () => ({ shareWindowsPicture }))

import { computerIpcContribution } from "../ipc"
import { sessionIpcContribution } from "../../session/ipc"

function fixture() {
  preferences.computerEnabled = true
  preferences.computerAlwaysForeground = false
  service.sendComputerPrompt.mockClear()
  service.sendPrompt.mockClear()
  service.invalidateComputerView.mockClear()
  service.subscriptions.onOwnerInvalidated.mockClear()
  service.controlComputer.mockReset().mockResolvedValue(true)
  service.subscriptions.getOwnerSessionId.mockReturnValue("session")
  service.subscriptions.getOwnerSessionRecord.mockReturnValue({ id: "session", status: "idle", metadata: {} })
  const source = "http://127.0.0.1:5173/"
  const frame = { url: source + "#/" }
  const contents = Object.assign(new EventEmitter(), { id: 8, mainFrame: frame, isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isVisible: (): boolean => true, isMinimized: () => false })
  const app = { paths: { rendererUrl: source }, windowManager: { getMain: () => window } }
  const registrations = computerIpcContribution.register(app as unknown as AppContext)
  const registration = sessionIpcContribution.register(app as unknown as AppContext)
    .find(item => item.channel === IpcChannels.sessionSendPrompt)
  return { registration: registration!, registrations, contents, frame, window }
}

it("returns the host's reason for unavailable computer control only to the main document", async () => {
  const { registrations, contents, frame } = fixture()
  const getAvailability = registrations.find(item => item.channel === IpcChannels.computerAvailability)!.handler
  await expect(getAvailability({ sender: contents, senderFrame: { ...frame } } as never)).rejects.toThrow(/主窗口/)
  computerAvailability.mockResolvedValueOnce("missing_driver")
  await expect(getAvailability({ sender: contents, senderFrame: frame } as never)).resolves.toBe("missing_driver")
})

it("waits for input release on disable and reports if release could not be confirmed", async () => {
  const { registration, registrations, contents, frame } = fixture()
  const update = registrations.find(item => item.channel === "computer:settings-update")?.handler
  const read = registrations.find(item => item.channel === "computer:settings-get")!.handler
  expect(update).toBeTypeOf("function")
  const cleanup = Promise.withResolvers<boolean>()
  service.disconnectComputer.mockReturnValueOnce(cleanup.promise)
  const event = { sender: contents, senderFrame: frame } as never
  const disable = update!(event, { setting: "enabled", value: false })
  const reopened = read(event)
  const prompt = { sessionId: "session", id: "during-disable", items: [] }
  await registration.handler(event, prompt)
  expect(service.sendPrompt).toHaveBeenCalledWith(prompt)
  expect(service.sendComputerPrompt).not.toHaveBeenCalled()
  await expect(update!(event, { setting: "enabled", value: true })).rejects.toThrow(/正在更新/)
  cleanup.resolve(false)
  await expect(disable).resolves.toMatchObject({ enabled: false, availability: "disabled", inputRelease: "unconfirmed" })
  await expect(reopened).resolves.toMatchObject({ enabled: false, inputRelease: "unconfirmed" })
  await expect(update!(event, { setting: "enabled", value: true })).rejects.toThrow(/重启/)
})

it("preserves ordinary sends without giving Computer to companion, subframe, or navigated document", async () => {
  const { registration, contents, frame } = fixture()
  const input = { sessionId: "session", id: "input", items: [] }
  await registration.handler({ sender: {}, senderFrame: frame } as never, input)
  await registration.handler({ sender: contents, senderFrame: { ...frame } } as never, input)
  frame.url = "https://example.test/"
  await registration.handler({ sender: contents, senderFrame: frame } as never, input)
  expect(service.sendPrompt).toHaveBeenCalledTimes(3)
  expect(service.sendComputerPrompt).not.toHaveBeenCalled()
})

it.each(["steer", "plan", "hidden", "other"] as const)("keeps %s messages on the ordinary path", async scenario => {
  const { registration, contents, frame, window } = fixture()
  if (scenario === "plan")
    service.subscriptions.getOwnerSessionRecord.mockReturnValue({ id: "session", status: "idle", metadata: { runtime: { workMode: "plan" } } })
  if (scenario === "hidden") window.isVisible = () => false
  const input = {
    sessionId: scenario === "other" ? "other" : "session", id: "input", items: [],
    ...(scenario === "steer" ? { delivery: "steer", expectedActiveRunId: "active" } : {}),
  }
  await registration.handler({ sender: contents, senderFrame: frame } as never, input)
  expect(service.sendPrompt).toHaveBeenCalledExactlyOnceWith(input)
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
  await vi.waitFor(() => expect(shareWindowsPicture).toHaveBeenCalledOnce())
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

it("scopes an app approval to its original chat and rejects the reply after a switch", async () => {
  const { registration, registrations, contents, frame } = fixture()
  const event = { sender: contents, senderFrame: frame } as never
  registration.handler(event, { sessionId: "session", id: "input", items: [] })
  const [, , , , interaction] = service.sendComputerPrompt.mock.calls[0]!
  const authorization = interaction.authorizeApp({ id: "calculator", name: "计算器" }, new AbortController().signal, "session")
  const { prompt } = contents.send.mock.lastCall![1]
  expect(prompt).toMatchObject({ kind: "authorize", sessionId: "session", appName: "计算器" })
  const reply = registrations.find(item => item.channel === IpcChannels.computerReply)!.handler
  service.subscriptions.getOwnerSessionId.mockReturnValue("other")
  expect(reply(event, { id: prompt.id, choice: "always" })).toBe(false)
  await expect(authorization).resolves.toBe(false)
  expect(contents.send.mock.lastCall![1]).toEqual({ type: "dismissed", id: prompt.id })
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
