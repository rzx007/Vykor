// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { DataRootSettings } from "../data-root-settings"
vi.mock("@renderer/lib/business-data", () => ({ recordLegacyBusinessScan: async () => ({ id: "fresh", ready: true }) }))

it("shows unresolved count/profile and enables migration only after the matching retained-copy acknowledgement and preview", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  let acknowledged = false, migrated = false
  const digest = "a".repeat(64)
  Object.defineProperty(window, "desktop", { configurable: true, value: {
    businessData: { acknowledgeUnresolvedComposer: async (value: string) => { expect(value).toBe(digest); acknowledged = true } },
    maintenance: {
      dataRootInfo: async () => ({ currentRoot: "C:/owned/source", source: "selector", retainedProfile: "C:/owned/electron", unresolvedComposer: acknowledged ? null : { count: 3, reason: "session-not-found", sourceDigest: digest } }),
      chooseDirectory: async () => "C:/owned/target",
      inspectDataRoot: async () => ({ sourceRoot: "C:/owned/source", targetRoot: "C:/owned/target", files: 2, bytes: 80, blockers: [], entries: [], impacts: [] }),
      migrateDataRoot: async () => { migrated = true; return { phase: "committed", usableRoot: "C:/owned/target" } },
    },
  } })
  const container = document.createElement("div"), root = createRoot(container)
  document.body.append(container)
  const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!
  try {
    await act(async () => root.render(<DataRootSettings />))
    expect(container.textContent).toContain("3 个旧会话无法归属")
    expect(container.textContent).toContain("C:/owned/electron")
    expect(button("迁移整根并重启").disabled).toBe(true)
    await act(async () => button("选择整根目录").click())
    await act(async () => button("只读预览").click())
    expect(button("迁移整根并重启").disabled).toBe(true)
    await act(async () => button("保留这些旧副本并继续").click())
    await act(async () => button("只读预览").click())
    expect(button("迁移整根并重启").disabled).toBe(false)
    await act(async () => button("迁移整根并重启").click())
    expect(migrated).toBe(true)
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
