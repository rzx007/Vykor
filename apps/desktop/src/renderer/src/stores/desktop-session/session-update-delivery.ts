import type {
  DesktopSessionResyncRequest,
  DesktopSessionUpdate,
  DesktopSessionUpdateAck,
  DesktopSessionUpdateAckResult,
} from "@shared/session-types"

interface SessionUpdateDeliveryAPI {
  acknowledgeUpdate: (ack: DesktopSessionUpdateAck) => Promise<DesktopSessionUpdateAckResult>
  requestUpdateResync: (
    request: DesktopSessionResyncRequest
  ) => Promise<DesktopSessionUpdateAckResult>
}

export interface SessionUpdateDeliveryAcknowledger {
  acknowledge(update: DesktopSessionUpdate, result: DesktopSessionUpdateAck["result"]): void
  dispose(): void
}

export function createSessionUpdateDeliveryAcknowledger(
  api: SessionUpdateDeliveryAPI,
  timeoutMs = 5_000
): SessionUpdateDeliveryAcknowledger {
  let timer: ReturnType<typeof setTimeout> | null = null
  let activeToken = 0
  let subscriptionId: string | null = null
  let lastAppliedDeliveryId: string | null = null

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  return {
    acknowledge(update, result) {
      if (subscriptionId !== update.subscriptionId) {
        subscriptionId = update.subscriptionId
        lastAppliedDeliveryId = null
      }
      clearTimer()
      const token = ++activeToken
      const ack: DesktopSessionUpdateAck = {
        subscriptionId: update.subscriptionId,
        generation: update.generation,
        deliveryId: update.deliveryId,
        result,
      }
      const request: DesktopSessionResyncRequest = {
        subscriptionId: update.subscriptionId,
        generation: update.generation,
        deliveryId: update.deliveryId,
        lastAppliedDeliveryId,
      }
      timer = setTimeout(() => {
        timer = null
        if (activeToken !== token) return
        try {
          void api.requestUpdateResync(request).catch((error: unknown) => {
            console.error("[session] failed to request update resync", error)
          })
        } catch (error) {
          console.error("[session] failed to request update resync", error)
        }
      }, timeoutMs)
      try {
        void api.acknowledgeUpdate(ack).then(
          ({ accepted }) => {
            if (activeToken !== token) return
            clearTimer()
            if (accepted && result === "applied") lastAppliedDeliveryId = update.deliveryId
          },
          (error: unknown) => {
            console.error("[session] failed to acknowledge update", error)
          }
        )
      } catch (error) {
        console.error("[session] failed to acknowledge update", error)
      }
    },
    dispose() {
      activeToken++
      clearTimer()
    },
  }
}
