import { app, BrowserWindow } from "electron"
import { OpenHarnessClient } from "@openharness/client"
import { type OpenHarnessHttpServer } from "@openharness/server"
import {
  clearDaemonRegistry,
  createBearerToken,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
} from "@openharness/server/daemon-host"

import { IpcEvents } from "../../../shared/ipc-channels"
import type { DesktopDaemonStatus, DesktopDaemonStatusPhase } from "../../../shared/session-types"
import { buildOutsideProjectRoot } from "./outside-project-workspace"

export class DaemonConnectionService {
  private clientPromise: Promise<OpenHarnessClient> | null = null
  private embeddedServer: OpenHarnessHttpServer | null = null
  private embeddedUrl: string | null = null
  private daemonStatus: DesktopDaemonStatus = createDaemonStatus("idle", "等待连接 daemon")

  getDaemonStatus(): DesktopDaemonStatus {
    return this.daemonStatus
  }

  getClient(): Promise<OpenHarnessClient> {
    this.clientPromise ??= this.connect()
    return this.clientPromise
  }

  refreshClient(): Promise<OpenHarnessClient> {
    this.clientPromise = null
    return this.getClient()
  }

  async dispose(): Promise<void> {
    const server = this.embeddedServer
    const embeddedUrl = this.embeddedUrl
    this.embeddedServer = null
    this.embeddedUrl = null
    this.clientPromise = null
    if (!server) return

    try {
      const registry = readDaemonRegistry()
      if (registry?.pid === process.pid && registry.url === embeddedUrl) clearDaemonRegistry()
    } catch {
      clearDaemonRegistry()
    }
    await server.close()
  }

  private async connect(): Promise<OpenHarnessClient> {
    try {
      this.setDaemonStatus("discovering", "正在查找 daemon")
      const registry = readDaemonRegistry()
      if (registry) {
        this.setDaemonStatus("connecting", "正在连接已运行的 daemon", {
          url: registry.url,
        })
        const client = new OpenHarnessClient({ baseUrl: registry.url, token: registry.token })
        await verifyDaemonWithTimeout(client)
        this.setDaemonStatus("ready", "daemon 已连接", { url: registry.url })
        return client
      }
    } catch (error) {
      console.warn("[session] registered daemon is unavailable, starting embedded daemon", error)
      this.setDaemonStatus("starting", "已注册 daemon 不可用，正在启动内置 daemon", {
        detail: errorMessage(error),
      })
      clearDaemonRegistry()
    }

    try {
      this.setDaemonStatus("starting", "正在启动内置 daemon")
      const token = createBearerToken()
      const { server, listen } = await startOpenHarnessDaemon({
        host: "127.0.0.1",
        port: 0,
        token,
        version: app.getVersion(),
        executionSurface: "desktop_managed",
        outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
      })
      this.embeddedServer = server
      this.embeddedUrl = listen.url
      writeDaemonRegistry({
        url: listen.url,
        pid: process.pid,
        token,
        storePath: server.store.path,
        startedAt: Date.now(),
        version: app.getVersion(),
      })
      this.setDaemonStatus("ready", "内置 daemon 已启动", { url: listen.url })
      return new OpenHarnessClient({ baseUrl: listen.url, token })
    } catch (error) {
      this.setDaemonStatus("error", "daemon 启动失败", { detail: errorMessage(error) })
      throw error
    }
  }

  private setDaemonStatus(
    phase: DesktopDaemonStatusPhase,
    message: string,
    options: { detail?: string; url?: string } = {}
  ): void {
    this.daemonStatus = createDaemonStatus(phase, message, options)
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (!webContents.isDestroyed()) {
        webContents.send(IpcEvents.sessionDaemonStatusChanged, this.daemonStatus)
      }
    }
  }
}

function createDaemonStatus(
  phase: DesktopDaemonStatusPhase,
  message: string,
  options: { detail?: string; url?: string } = {}
): DesktopDaemonStatus {
  return {
    phase,
    message,
    ...options,
    updatedAt: Date.now(),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function verifyDaemonWithTimeout(client: OpenHarnessClient): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    await client.protocol.health({ signal: controller.signal })
    await client.projects.list({ signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
