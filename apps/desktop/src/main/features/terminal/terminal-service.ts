import type { WebContents } from "electron"
import type {
  OpenHarnessClient,
  TerminalCreateRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalWriteRequest,
} from "@openharness/client"

import { IpcEvents } from "../../../shared/ipc-channels"
import { getDesktopPreferences } from "../settings/desktop-preferences"
import { applyPreferredTerminalShell } from "./apply-preferred-shell"
import { listDetectedTerminalShells, resolvePreferredTerminalShell } from "./detect-shells"
import { desktopSessionService } from "../session/session-service"
import { desktopSettingsService } from "../settings/settings-service"

type TerminalClient = Pick<OpenHarnessClient, "terminals">

interface TerminalSubscription {
  controller: AbortController
}

class DesktopTerminalService {
  private readonly subscriptions = new Map<number, TerminalSubscription>()

  async create(
    webContents: WebContents,
    input: TerminalCreateRequest
  ): Promise<TerminalSessionInfo> {
    this.ensureSubscription(webContents)
    const preferred = resolvePreferredTerminalShell(
      getDesktopPreferences().defaultTerminalShellId ?? null,
      listDetectedTerminalShells()
    )
    const settings = await desktopSettingsService.snapshot()
    const next = applyPreferredTerminalShell(
      input,
      preferred,
      settings.agentEnvironment === "native"
    )
    return await withDaemonRetry((client) => client.terminals.create(next))
  }

  async write(webContents: WebContents, input: TerminalWriteRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.terminals.write(input))
  }

  async resize(webContents: WebContents, input: TerminalResizeRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.terminals.resize(input))
  }

  async read(webContents: WebContents, input: TerminalReadRequest): Promise<TerminalReadResult> {
    this.ensureSubscription(webContents)
    return await withDaemonRetry((client) => client.terminals.read(input.terminalId))
  }

  async kill(webContents: WebContents, terminalId: string): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.terminals.close(terminalId))
  }

  async list(webContents: WebContents): Promise<TerminalSessionInfo[]> {
    this.ensureSubscription(webContents)
    return await withDaemonRetry((client) => client.terminals.list())
  }

  async dispose(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.controller.abort()
    this.subscriptions.clear()
  }

  private ensureSubscription(webContents: WebContents): void {
    if (this.subscriptions.has(webContents.id)) return
    const controller = new AbortController()
    this.subscriptions.set(webContents.id, { controller })
    webContents.once("destroyed", () => {
      controller.abort()
      this.subscriptions.delete(webContents.id)
    })
    void this.pumpEvents(webContents, controller)
  }

  private async pumpEvents(webContents: WebContents, controller: AbortController): Promise<void> {
    try {
      const client = await desktopSessionService.daemonClient()
      for await (const event of client.terminals.streamEvents({ signal: controller.signal })) {
        if (controller.signal.aborted || webContents.isDestroyed()) return
        if (event.type === "data") webContents.send(IpcEvents.terminalData, event)
        else if (event.type === "status") webContents.send(IpcEvents.terminalStatus, event)
        else if (event.type === "exit") webContents.send(IpcEvents.terminalExit, event)
        else if (event.type === "error") webContents.send(IpcEvents.terminalError, event)
      }
    } catch (error) {
      if (!controller.signal.aborted && !webContents.isDestroyed()) {
        console.error("[terminal] event stream failed", error)
      }
    }
  }
}

export const desktopTerminalService = new DesktopTerminalService()

async function withDaemonRetry<T>(
  operation: (client: TerminalClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    if (!shouldRefreshDaemonClient(error)) throw error
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}

function shouldRefreshDaemonClient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("Failed to fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("Cannot find module './prebuilds") ||
    message.includes("Failed to load native module: conpty.node")
  )
}
