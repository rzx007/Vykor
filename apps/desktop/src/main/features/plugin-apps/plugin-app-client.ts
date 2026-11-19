import type { HttpTransport, VykorClient } from "@rzx/client"
import { SystemResource } from "@vykor/daemon-admin/configuration"
import { PluginAppResource } from "./plugin-app-resource"

export type PluginAppClient = Pick<VykorClient, "protocol" | "sessions" | "runtime"> & {
  pluginApps: PluginAppResource
  system: Pick<SystemResource, "getSettings">
}

const clients = new WeakMap<HttpTransport, PluginAppClient>()

/** Mounted app feeds share identity until Desktop replaces the daemon connection. */
export function clientForPluginApps(agent: VykorClient, transport: HttpTransport): PluginAppClient {
  const previous = clients.get(transport)
  if (previous) return previous
  const client = {
    protocol: agent.protocol,
    sessions: agent.sessions,
    runtime: agent.runtime,
    pluginApps: new PluginAppResource(transport),
    system: new SystemResource(transport),
  }
  clients.set(transport, client)
  return client
}
