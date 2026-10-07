import type { WebContents } from "electron"
import type {
  VykorClient,
  TerminalCreateRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalWriteRequest,
} from "@vykor/client"

import { IpcEvents } from "../../../shared/ipc-channels"
import { getDesktopPreferences } from "../settings/desktop-preferences"
import { listDetectedTerminalShells, resolvePreferredTerminalShell } from "./detect-shells"
import { desktopSessionService } from "../session/session-service"
import { desktopRuntimeSettingsService } from "../settings/runtime-settings-service"
import { desktopTerminalSettingsService, terminalShellFileError } from "../settings/terminal-settings-service"

type TerminalClient = Pick<VykorClient, "terminals">

interface TerminalSubscription {
  controller: AbortController
}

class DesktopTerminalService {
  private readonly subscriptions = new Map<number, TerminalSubscription>()

  constructor() {
    desktopSessionService.onDaemonInvalidated(() => { void this.dispose() })
  }

  async create(
    webContents: WebContents,
    input: TerminalCreateRequest
  ): Promise<TerminalSessionInfo> {
    this.ensureSubscription(webContents)
    const preferences = getDesktopPreferences()
    const client = await desktopSessionService.daemonClient()
    const session = input.scope.kind === "session" ? await client.sessions.get(input.scope.sessionId) : null
    const cwd = session?.cwd ?? (await client.projects.list()).find((project) => project.id === (input.scope.kind === "project" ? input.scope.projectId : ""))?.path
    if (!cwd) throw new Error("终端项目目录不可用。")
    const desktopMetadata = session?.metadata?.desktop as { settingsRoot?: unknown } | undefined
    const settingsRoot = typeof desktopMetadata?.settingsRoot === "string" ? desktopMetadata.settingsRoot : cwd
    const native = input.runtime === "local" || (await desktopRuntimeSettingsService.snapshot({ cwd: settingsRoot })).effective.kind === "native"
    const terminalSettings = preferences.terminal
    let shell = input.shell
    let shellArgs = input.shellArgs
    if (!shell?.trim()) {
      if (native && terminalSettings?.customShell) {
        const error = terminalShellFileError(terminalSettings.customShell.executable)
        if (error) throw new Error(error)
        shell = terminalSettings.customShell.executable
        shellArgs = terminalSettings.customShell.args
      } else if (native) {
        shell = resolvePreferredTerminalShell(preferences.defaultTerminalShellId, listDetectedTerminalShells())
        if (preferences.defaultTerminalShellId && !shell) throw new Error("已保存的 Shell 不可用，请在终端设置中重新选择。")
      } else if (terminalSettings?.wslShell) {
        shell = terminalSettings.wslShell
        shellArgs = terminalSettings.wslShellArgs
      }
    }
    const next = { ...input, shell, shellArgs, env: { ...desktopTerminalSettingsService.launchEnvironment(), ...input.env } }
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
    } finally {
      if (this.subscriptions.get(webContents.id)?.controller === controller) {
        this.subscriptions.delete(webContents.id)
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
