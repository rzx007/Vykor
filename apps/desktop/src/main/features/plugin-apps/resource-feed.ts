import type { VykorClient } from "@rzx/client"
import type { AppMountBinding } from "./plugin-app-service"

/** One authenticated stream for the whole owning window, including hidden mounted pages. */
export class WindowResourceFeed {
  private abort?: AbortController
  private key = ""
  private generation = 0
  private client?: VykorClient
  private readonly reads = new Map<AppMountBinding, Set<string>>()
  constructor(private readonly emit: (mount: AppMountBinding) => void) {}
  read(mount: AppMountBinding, uri: string): void {
    let uris = this.reads.get(mount)
    if (!uris) { uris = new Set(); this.reads.set(mount, uris) }
    if (uris.size >= 32 && !uris.has(uri)) return
    uris.add(uri); this.sync()
  }
  remove(mount: AppMountBinding): void { this.reads.delete(mount); this.sync() }
  sync(): void {
    const entries = [...this.reads].filter(([mount]) => mount.admitted && mount.online && mount.response.lease && mount.response.app.backendKind === "mcp-server")
    const key = JSON.stringify(entries.map(([mount, uris]) => [mount.mountId, mount.response.lease, [...uris]]))
    const client = entries[0]?.[0].client
    if (key === this.key && client === this.client) return
    this.client = client
    this.key = key; this.abort?.abort(); const abort = this.abort = new AbortController()
    const generation = ++this.generation
    if (!client || typeof client.pluginApps.notifications !== "function") return
    const selected = entries.filter(([mount]) => mount.client === client)
    const watches: Parameters<VykorClient["pluginApps"]["notifications"]>[0] = selected.map(([mount, uris]) => ({
      source: mount.response.source, lease: mount.response.lease!, leaseGeneration: generation, uris: [...uris],
    }))
    const run = async () => {
      while (!abort.signal.aborted) {
        try {
          let epoch: string | undefined
          for await (const notice of client.pluginApps.notifications(watches, abort.signal)) {
            if (abort.signal.aborted || generation !== this.generation) break
            if (notice.kind === "resync") epoch = notice.runtimeEpoch
            if (notice.runtimeEpoch !== epoch) continue
            for (const [mount, uris] of selected) {
              if (!mount.admitted || mount.client !== client || !mount.online) continue
              if (notice.kind === "resync" || (notice.appId === mount.response.source.appId && notice.leaseGeneration === generation && uris.has(notice.uri))) this.emit(mount)
            }
          }
        } catch { /* Reconnect reads data only; no replay of tools or messages. */ }
        if (!abort.signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve() }
          const timer = setTimeout(done, 1000); abort.signal.addEventListener("abort", done, { once: true })
        })
      }
    }
    void run()
  }
  dispose(): void { this.abort?.abort(); this.reads.clear(); this.key = "" }
}
