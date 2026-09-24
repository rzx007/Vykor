import type { DaemonRegistry } from "@vykor/server/daemon-host"
import {
  clearDaemonRegistry,
  readDaemonRegistry,
  stopDaemonProcess,
} from "@vykor/server/daemon-host"

import { createDesktopDaemonSystemService } from "./daemon-autostart-service"
import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "./daemon-surface"

export async function stopNonDesktopDaemon(registry: DaemonRegistry): Promise<void> {
  if (!isLoopbackDaemonUrl(registry.url)) {
    throw new Error(`Refusing to stop a non-loopback daemon at ${registry.url}`)
  }
  await stopDaemonProcess(registry.pid)
  clearDaemonRegistry()
}

export interface DesktopServiceReconciler {
  uninstall(): void
  install(): void
}

export async function reconcileDesktopManagedService(
  registry: DaemonRegistry,
  service: DesktopServiceReconciler = createDesktopDaemonSystemService()
): Promise<void> {
  service.uninstall()
  if (isLoopbackDaemonUrl(registry.url)) {
    await stopDaemonProcess(registry.pid)
  }
  clearDaemonRegistry()
  service.install()
  await waitForDesktopManagedRegistry()
}

export async function waitForDesktopManagedRegistry(
  options: {
    timeoutMs?: number
    readRegistry?: () => DaemonRegistry | undefined
    isHealthy?: (registry: DaemonRegistry) => Promise<boolean>
  } = {}
): Promise<DaemonRegistry> {
  const readRegistry = options.readRegistry ?? readDaemonRegistry
  const isHealthy = options.isHealthy ?? defaultRegistryHealthy
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const registry = readRegistry()
    if (registry && isDesktopManagedRegistry(registry) && (await isHealthy(registry))) {
      return registry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The desktop-managed daemon did not become ready within 15 seconds")
}

async function defaultRegistryHealthy(registry: DaemonRegistry): Promise<boolean> {
  try {
    const response = await fetch(`${registry.url.replace(/\/+$/, "")}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}
