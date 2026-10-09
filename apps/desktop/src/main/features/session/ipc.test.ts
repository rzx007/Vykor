import { afterEach, expect, it, vi } from "vitest"

import { IpcChannels } from "../../../shared/ipc-channels"
import { desktopSessionService } from "./session-service"
import { sessionIpcContribution } from "./ipc"

afterEach(() => vi.restoreAllMocks())

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
