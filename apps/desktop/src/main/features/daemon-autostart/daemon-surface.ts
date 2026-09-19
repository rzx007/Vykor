import type { DaemonRegistry } from "@openharness/server/daemon-host"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function isDesktopManagedRegistry(
  registry: Pick<DaemonRegistry, "executionSurface">,
): boolean {
  return registry.executionSurface === "desktop_managed"
}

export function isLoopbackDaemonUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}
