// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"
import { PluginAppResultObserver, usePluginAppResults } from "../use-plugin-app-results"
const present = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("../provider", () => ({ usePluginApps: () => ({ presentToolResult: present }) }))
const part = (id: string, status = "completed", sessionId = "session"): DesktopSessionPart => ({
  id, sessionId, messageId: "message", seq: 0, type: "tool", status, createdAt: Date.now(), updatedAt: Date.now(),
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
  expect(present).toHaveBeenCalledExactlyOnceWith("session", "active", true, false)
  expect(container.innerHTML).toBe("")
  await act(async () => root.unmount())
})
it("does not auto-reveal old creations hydrated after an initially empty transcript", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  function Observer({ parts }: { parts: DesktopSessionPart[] }) { usePluginAppResults(parts); return null }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(<Observer parts={[]} />))
  const history = { ...part("late-history"), createdAt: 1, updatedAt: 1, toolName: "mcp__excalidraw__create_diagram",
    metadata: { pluginAppSource: { pluginId: "dev.vykor.excalidraw" } } }
  await act(async () => root.render(<Observer parts={[history]} />))
  expect(present).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})
it("requests automatic reveal only for a fresh successful Excalidraw creation, never a read or historical result", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const drawing = (id: string, toolName: string, status = "completed") => ({
    ...part(id, status), toolName,
    metadata: { pluginAppSource: { pluginId: "dev.vykor.excalidraw", backendId: "excalidraw", resourceUri: "ui://excalidraw/panel.html" } },
  })
  function Observer({ parts }: { parts: DesktopSessionPart[] }) { usePluginAppResults(parts); return null }
  const container = document.createElement("div"), root = createRoot(container)
  const history = drawing("history", "mcp__excalidraw__create_diagram")
  await act(async () => root.render(<Observer parts={[history]} />))
  expect(present).not.toHaveBeenCalled()
  const read = drawing("read", "mcp__excalidraw__read_scene")
  const created = drawing("created", "mcp__excalidraw__create_diagram")
  const updated = drawing("updated", "mcp__excalidraw__apply_operations")
  const failed = { ...drawing("failed", "mcp__excalidraw__create_diagram"), isError: true }
  const unrelated = { ...created, id: "unrelated", metadata: part("unrelated").metadata }
  await act(async () => root.render(<Observer parts={[history, read, created, updated, failed, unrelated]} />))
  expect(present.mock.calls).toEqual([
    ["session", "read", true, false], ["session", "created", true, true],
    ["session", "updated", true, false], ["session", "unrelated", true, false],
  ])
  await act(async () => root.unmount())
})

it("reveals a creation observed running even when server timestamps are behind the local clock", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  function Observer({ parts }: { parts: DesktopSessionPart[] }) { usePluginAppResults(parts); return null }
  const root = createRoot(document.createElement("div"))
  const running = { ...part("active", "running"), createdAt: 1, updatedAt: 1, toolName: "mcp__excalidraw__create_diagram",
    metadata: { pluginAppSource: { pluginId: "dev.vykor.excalidraw" } } }
  await act(async () => root.render(<Observer parts={[running]} />))
  await act(async () => root.render(<Observer parts={[{ ...running, status: "completed" }]} />))
  expect(present).toHaveBeenCalledExactlyOnceWith("session", "active", true, true)
  await act(async () => root.unmount())
})
