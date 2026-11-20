// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
vi.mock("../lib/business-data", () => ({ importOtherLegacyBusinessData: async () => {}, recordLegacyBusinessScan: async () => ({ id: "owned", ready: true }) }))
vi.mock("../stores/desktop-session/composer-recovery", () => ({ readComposerRecovery: async () => ({}) }))
import DataRootMaintenance from "../data-root-maintenance"
it("dismisses the normal startup overlay when the restricted maintenance page commits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  Object.defineProperty(window, "desktop", { configurable: true, value: { maintenance: {
    dataRootInfo: async () => ({ currentRoot: "owned", source: "host", retainedProfile: "owned-profile", unresolvedComposer: null }),
  } } })
  const overlay = document.createElement("div"); overlay.id = "startup-loading"; document.body.append(overlay)
  const container = document.createElement("div"), root = createRoot(container); document.body.append(container)
  try {
    await act(async () => root.render(<DataRootMaintenance />))
    expect(overlay.dataset.startupReady).toBe("true")
    expect(container.textContent).toContain("用户数据根")
  } finally { act(() => root.unmount()); overlay.remove(); container.remove(); vi.unstubAllGlobals() }
})
