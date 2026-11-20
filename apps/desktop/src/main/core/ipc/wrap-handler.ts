import type { IpcMainInvokeEvent } from 'electron'

import type { IpcHandler } from './types'
import { desktopOperationGate } from './operation-gate'

export function wrapIpcHandler(
  contributionId: string,
  channel: string,
  handler: IpcHandler
): IpcHandler {
  return (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      const result = desktopOperationGate.run(channel, () => handler(event, ...args))
      return Promise.resolve(result).catch((error: unknown) => {
        logIpcError(contributionId, channel, error)
        throw normalizeError(error)
      })
    } catch (error) {
      logIpcError(contributionId, channel, error)
      throw normalizeError(error)
    }
  }
}

function logIpcError(contributionId: string, channel: string, error: unknown): void {
  console.error(`[ipc:${contributionId}] ${channel} failed`, error)
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
