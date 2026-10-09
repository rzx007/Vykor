import { afterEach, expect, it, vi } from "vitest"

import type { DesktopSessionUpdate } from "@shared/session-types"
import { emptySessionView } from "./store-test-fixtures"
import { createSessionUpdateDeliveryAcknowledger } from "./session-update-delivery"

afterEach(() => vi.useRealTimers())

it("requests one snapshot recovery when an update ACK is not confirmed in time", async () => {
  vi.useFakeTimers()
  let resolveAck!: (result: { accepted: boolean }) => void
  const acknowledgeUpdate = vi.fn(
    () => new Promise<{ accepted: boolean }>((resolve) => { resolveAck = resolve })
  )
  const requestUpdateResync = vi.fn(async () => ({ accepted: true }))
  const delivery = createSessionUpdateDeliveryAcknowledger(
    { acknowledgeUpdate, requestUpdateResync },
    5
  )
  const update: DesktopSessionUpdate = {
    kind: "part-delta",
    subscriptionId: "primary:1",
    generation: 3,
    deliveryId: "delivery-8",
    sessionId: "s1",
    deltas: [],
  }

  delivery.acknowledge(update, "applied")
  expect(acknowledgeUpdate).toHaveBeenCalledWith({
    subscriptionId: "primary:1",
    generation: 3,
    deliveryId: "delivery-8",
    result: "applied",
  })

  await vi.advanceTimersByTimeAsync(5)
  expect(requestUpdateResync).toHaveBeenCalledWith({
    subscriptionId: "primary:1",
    generation: 3,
    deliveryId: "delivery-8",
    lastAppliedDeliveryId: null,
  })

  resolveAck({ accepted: true })
  await Promise.resolve()
  delivery.dispose()
})

it("clears the watchdog after an ACK is accepted and remembers its delivery", async () => {
  vi.useFakeTimers()
  const acknowledgeUpdate = vi.fn(async () => ({ accepted: true }))
  const requestUpdateResync = vi.fn(async () => ({ accepted: true }))
  const delivery = createSessionUpdateDeliveryAcknowledger(
    { acknowledgeUpdate, requestUpdateResync },
    5
  )
  const update: DesktopSessionUpdate = {
    kind: "snapshot",
    subscriptionId: "aux-1",
    generation: 4,
    deliveryId: "delivery-9",
    view: emptySessionView("s1"),
  }

  delivery.acknowledge(update, "applied")
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(5)

  expect(requestUpdateResync).not.toHaveBeenCalled()
  delivery.dispose()
})

it("removes a pending watchdog when its subscription owner is disposed", async () => {
  vi.useFakeTimers()
  const acknowledgeUpdate = vi.fn(
    () => new Promise<{ accepted: boolean }>(() => undefined)
  )
  const requestUpdateResync = vi.fn(async () => ({ accepted: true }))
  const delivery = createSessionUpdateDeliveryAcknowledger(
    { acknowledgeUpdate, requestUpdateResync },
    5
  )
  const update: DesktopSessionUpdate = {
    kind: "part-delta",
    subscriptionId: "aux-2",
    generation: 1,
    deliveryId: "delivery-10",
    sessionId: "s2",
    deltas: [],
  }

  delivery.acknowledge(update, "applied")
  delivery.dispose()
  await vi.advanceTimersByTimeAsync(5)

  expect(requestUpdateResync).not.toHaveBeenCalled()
})
