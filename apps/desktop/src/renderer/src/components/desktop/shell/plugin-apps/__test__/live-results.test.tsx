// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"
import { PluginAppResultObserver, usePluginAppResults } from "../use-plugin-app-results"
const present = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("../provider", () => ({ usePluginApps: () => ({ presentToolResult: present }) }))
const part = (id: string, status = "completed", sessionId = "session"): DesktopSessionPart => ({
  id, sessionId, messageId: "message", seq: 0, type: "tool", status, createdAt: 1, updatedAt: 1,
  metadata: { pluginAppSource: { pluginId: "example", backendId: "editor", resourceUri: "ui://editor" } },
} as DesktopSessionPart)
afterEach(() => { present.mockClear(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT") })
it("never replays historical completions but delivers a tool running at initial mount", () => {
  const observer = new PluginAppResultObserver([part("history"), part("active", "running")])
  expect(observer.observe([part("history"), part("active", "running")])).toEqual([])
  expect(observer.observe([part("history"), part("active")]).map(item => item.id)).toEqual(["active"])
  expect(observer.observe([part("history"), part("active")])).toEqual([])
  expect(observer.observe([part("other-history", "completed", "other-session")])).toEqual([])
})
it("observes incoming results without rendering any message rows or application iframe", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  function TranscriptObserver({ parts }: { parts: DesktopSessionPart[] }) { usePluginAppResults(parts); return null }
  const container = document.createElement("div"), root = createRoot(container)
  await act(async () => root.render(<TranscriptObserver parts={[part("history"), part("active", "running")]} />))
  expect(present).not.toHaveBeenCalled()
  await act(async () => root.render(<TranscriptObserver parts={[part("history"), part("active")]} />))
  expect(present).toHaveBeenCalledExactlyOnceWith("session", "active", true)
  expect(container.innerHTML).toBe("")
  await act(async () => root.unmount())
})
