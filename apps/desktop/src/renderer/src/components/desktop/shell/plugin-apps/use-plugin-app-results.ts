import { useEffect, useRef } from "react"
import type { DesktopSessionPart } from "@shared/session-types"
import { usePluginApps } from "./provider"

/** 观察整份会话投影，不依赖某一条消息是否滚入可见区域。 */
export class PluginAppResultObserver {
  private sessionId?: string
  private readonly settled = new Set<string>()
  private readonly started = new Set<string>()
  constructor(parts: DesktopSessionPart[]) {
    this.sessionId = parts[0]?.sessionId
    for (const part of parts) {
      if (part.status === "completed") this.settled.add(part.id)
      if (part.status === "running" || part.status === "pending") this.started.add(part.id)
    }
  }
  wasStarted(id: string): boolean { return this.started.has(id) }
  observe(parts: DesktopSessionPart[]): DesktopSessionPart[] {
    const sessionId = parts[0]?.sessionId
    if (sessionId && sessionId !== this.sessionId) {
      this.settled.clear()
      this.started.clear()
      for (const part of parts) if (part.status === "completed") this.settled.add(part.id)
    }
    this.sessionId = sessionId ?? this.sessionId
    const results: DesktopSessionPart[] = []
    for (const part of parts) {
      if (part.status === "running" || part.status === "pending") this.started.add(part.id)
      if (part.type !== "tool" || part.status !== "completed" || part.isError || !part.metadata.pluginAppSource || this.settled.has(part.id)) continue
      this.settled.add(part.id)
      results.push(part)
    }
    return results
  }
}

export function usePluginAppResults(parts: DesktopSessionPart[]): void {
  const manager = usePluginApps()
  const enteredAt = useRef(Date.now())
  const observer = useRef<PluginAppResultObserver | null>(null)
  observer.current ??= new PluginAppResultObserver(parts)
  useEffect(() => {
    for (const part of observer.current!.observe(parts)) {
      // 只识别已知的画板创建结果；读取、编辑和历史结果不推断为打开请求。
      const source = part.metadata.pluginAppSource as { pluginId?: string }
      const reveal = source.pluginId === "dev.vykor.excalidraw" && part.toolName === "mcp__excalidraw__create_diagram"
        && (observer.current!.wasStarted(part.id) || part.updatedAt >= enteredAt.current)
      // 失败保留聊天中的显式重试入口；不会重试工具或重放消息。
      void manager?.presentToolResult(part.sessionId, part.id, true, reveal).catch(() => {})
    }
  }, [manager, parts])
}
