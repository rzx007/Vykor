import type { PluginAppModelContext } from "@shared/plugin-app-types"
const empty: readonly PluginAppModelContext[] = []
/** Window-local, session-scoped selections, independent from editor documents and attachments. */
export class PluginAppModelContexts {
  private entries: readonly PluginAppModelContext[] = empty
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.entries
  forSession(sessionId: string | null) { return this.entries.filter(entry => entry.source.sessionId === sessionId) }
  put(entry: PluginAppModelContext): void {
    this.entries = [...this.entries.filter(prior => prior.source.sessionId !== entry.source.sessionId || prior.source.appId !== entry.source.appId), entry]
    this.listeners.forEach(listener => listener())
  }
  remove(id: string): void {
    this.entries = this.entries.filter(entry => entry.id !== id)
    this.listeners.forEach(listener => listener())
  }
}
export const pluginAppModelContexts = new PluginAppModelContexts()
