import { spawn } from "node:child_process"

import {
  clearDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  readDaemonRegistry,
  startVykorDaemon,
  stopDaemonProcess,
  writeDaemonRegistry,
  shouldStartManagedDaemon,
  type DaemonRegistry,
} from "@vykor/server/daemon-host"
import { app } from "electron"

import { buildOutsideProjectRoot } from "../session/outside-project-workspace"
import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "./daemon-surface"

export type DesktopDaemonMode = "service" | "watchdog"

export function resolveDesktopDaemonMode(argv: readonly string[]): DesktopDaemonMode | null {
  if (argv.includes("--daemon-service")) return "service"
  if (argv.includes("--daemon-watchdog")) return "watchdog"
  return null
}

export async function runDesktopDaemonEntry(mode: DesktopDaemonMode): Promise<void> {
  if (mode === "watchdog") {
    if (await registeredDaemonHealthy()) return
    if (!(await shouldStartManagedDaemon())) return
    const args = app.isPackaged ? ["--daemon-service"] : [app.getAppPath(), "--daemon-service"]
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    return
  }

  while (await registeredDaemonHealthy()) {
    await delay(2_000)
  }
  const stale = readDaemonRegistry()
  if (stale && !isDesktopManagedRegistry(stale) && isLoopbackDaemonUrl(stale.url)) {
    await stopDaemonProcess(stale.pid).catch((error) => {
      console.warn("[daemon] failed to stop non-desktop daemon", error)
    })
  }
  clearDaemonRegistry()
  const token = createBearerToken()
  const { server, listen } = await startVykorDaemon({
    host: "127.0.0.1",
    port: 0,
    token,
    version: app.getVersion(),
    executionSurface: "desktop_managed",
    outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
  })
  writeDaemonRegistry(
    createDaemonRegistryEntry({
      url: listen.url,
      pid: process.pid,
      token,
      storePath: server.store.path,
      version: app.getVersion(),
      executionSurface: "desktop_managed",
    })
  )

  await new Promise<void>((resolve) => {
    const close = (): void => {
      clearDaemonRegistry()
      void server.close().finally(resolve)
    }
    process.once("SIGINT", close)
    process.once("SIGTERM", close)
  })
}

export async function registeredDaemonHealthy(
  readRegistry: () => DaemonRegistry | undefined = readDaemonRegistry,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const registry = readRegistry()
  if (!registry || !isDesktopManagedRegistry(registry)) return false
  try {
    const response = await fetchImpl(`${registry.url}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
