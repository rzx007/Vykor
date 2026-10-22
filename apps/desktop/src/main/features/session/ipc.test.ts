import { afterEach, expect, it, vi } from "vitest"

vi.mock("./session-service", () => ({ desktopSessionService: {
  sendPrompt: vi.fn(), goalAction: vi.fn(), acknowledgeSessionUpdate: vi.fn(), requestSessionUpdateResync: vi.fn(),
} }))

import { IpcChannels } from "../../../shared/ipc-channels"
import { desktopSessionService } from "./session-service"
import { sessionIpcContribution } from "./ipc"
import * as pluginAppRuntime from "../plugin-apps/service-runtime"

afterEach(() => vi.restoreAllMocks())

it.each([false, true])("waits for local supplemental context preparation before resuming a Goal (failure=%s)", async failed => {
  let release!: () => void
  let reject!: (error: Error) => void
  const context = new Promise<never[]>((resolve, no) => { release = () => resolve([]); reject = no })
  vi.spyOn(pluginAppRuntime, "requireDesktopPluginAppService").mockReturnValue({
    isOwner: () => true, composerContext: () => context,
  } as never)
  const order: string[] = []
  vi.spyOn(desktopSessionService, "sendPrompt").mockImplementation(async () => { order.push("prompt") })
  vi.spyOn(desktopSessionService, "goalAction").mockImplementation(async () => { order.push("resume"); return {} as never })
  const handlers = sessionIpcContribution.register({} as never)
  const send = handlers.find(item => item.channel === IpcChannels.sessionSendPrompt)!
  const resume = handlers.find(item => item.channel === IpcChannels.sessionGoalAction)!
  const mainFrame = {}
  const event = { sender: { id: 42, mainFrame }, senderFrame: mainFrame } as never
  const sending = Promise.resolve(send.handler(event, { sessionId: "s", pluginAppContextIds: ["context"] }))
    .then(() => undefined, error => error.message)
  const continuing = Promise.resolve(resume.handler(event, { sessionId: "s", action: "resume" }))
    .then(() => undefined, error => error.message)
  await Promise.resolve()
  expect(order).toEqual([])
  if (failed) reject(new Error("context failed")); else release()
  await sending
  await continuing
  expect(order).toEqual(failed ? [] : ["prompt", "resume"])
  // A failed preparation must not poison later, explicitly requested continuation.
  if (failed) {
    await resume.handler(event, { sessionId: "s", action: "resume" })
    expect(order).toEqual(["resume"])
  }
})

it.each([false, true])("waits for every same-session send, isolates other sessions and leaves pause available (send fails=%s)", async failed => {
  const releases: Array<() => void> = []
  const order: string[] = []
  vi.spyOn(desktopSessionService, "sendPrompt").mockImplementation(() => new Promise<void>((resolve, reject) => {
    const failThisSend = failed && releases.length === 0
    releases.push(() => failThisSend ? reject(new Error("send failed")) : resolve())
  }))
  vi.spyOn(desktopSessionService, "goalAction").mockImplementation(async input => {
    order.push(`${input.sessionId}:${input.action}`); return {} as never
  })
  const handlers = sessionIpcContribution.register({} as never)
  const send = handlers.find(item => item.channel === IpcChannels.sessionSendPrompt)!
  const action = handlers.find(item => item.channel === IpcChannels.sessionGoalAction)!
  const event = {} as never
  const first = Promise.resolve(send.handler(event, { sessionId: "s" })).catch(error => error.message)
  const continuing = Promise.resolve(action.handler(event, { sessionId: "s", action: "resume" })).then(() => undefined, error => error.message)
  const second = Promise.resolve(send.handler(event, { sessionId: "s" })).catch(error => error.message)
  await action.handler(event, { sessionId: "other", action: "resume" })
  await action.handler(event, { sessionId: "s", action: "pause" })
  expect(order).toEqual(["other:resume", "s:pause"])
  releases.shift()!()
  await first
  expect(order).toEqual(["other:resume", "s:pause"])
  releases.shift()!()
  await second
  expect(await continuing).toBe(failed ? "send failed" : undefined)
  expect(order).toEqual(failed ? ["other:resume", "s:pause"] : ["other:resume", "s:pause", "s:resume"])
})

it("routes update ACKs using the invoking Electron sender", () => {
  const acknowledge = vi
    .spyOn(desktopSessionService, "acknowledgeSessionUpdate")
    .mockReturnValue({ accepted: true })
  const registration = sessionIpcContribution
    .register({} as never)
    .find((candidate) => candidate.channel === IpcChannels.sessionUpdateAck)
  expect(registration).toBeDefined()

  const ack = {
    subscriptionId: "primary:1",
    generation: 7,
    deliveryId: "delivery-1",
    result: "applied",
  }
  expect(registration!.handler({ sender: { id: 42 } } as never, ack)).toEqual({
    accepted: true,
  })
  expect(acknowledge).toHaveBeenCalledWith(42, ack)
})

it("routes resync requests using the invoking Electron sender", () => {
  const resync = vi
    .spyOn(desktopSessionService, "requestSessionUpdateResync")
    .mockReturnValue({ accepted: true })
  const registration = sessionIpcContribution
    .register({} as never)
    .find((candidate) => candidate.channel === IpcChannels.sessionUpdateResync)
  expect(registration).toBeDefined()

  const request = {
    subscriptionId: "side-chat",
    generation: 7,
    deliveryId: "delivery-1",
    lastAppliedDeliveryId: null,
  }
  expect(registration!.handler({ sender: { id: 42 } } as never, request)).toEqual({
    accepted: true,
  })
  expect(resync).toHaveBeenCalledWith(42, request)
})
