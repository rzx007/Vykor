// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSettingsSnapshot } from "@shared/settings-types"
import type { WorkspaceOpener } from "@shared/workspace-types"

import { DefaultOpenerControl } from "./default-opener-control"

describe("DefaultOpenerControl", () => {
  let container: HTMLDivElement
  let root: Root
  let snapshot: ReturnType<typeof vi.fn>
  let updateDefaultOpener: ReturnType<typeof vi.fn>
  let listOpeners: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    snapshot = vi.fn(async () => settingsSnapshot("cursor"))
    updateDefaultOpener = vi.fn(async (input: { defaultOpenerId: string }) =>
      settingsSnapshot(input.defaultOpenerId)
    )
    listOpeners = vi.fn(async () => openers)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        settings: { snapshot, updateDefaultOpener },
        workspace: { listOpeners },
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("renders detected openers instead of a hardcoded VS Code button", async () => {
    await renderControl()
    expect(container.textContent).toContain("Cursor")
    expect(trigger()?.textContent).toContain("Cursor")
    expect(trigger()?.textContent).not.toBe("VS Code")
    expect(container.querySelector('img[src="data:image/png;base64,aaa"]')).not.toBeNull()
  })

  it("uses the resolved opener when the saved id is gone", async () => {
    snapshot.mockResolvedValue(settingsSnapshot("gone"))
    await renderControl()
    expect(trigger()?.textContent).toContain("Cursor")
  })

  it("disables the control when no openers are installed", async () => {
    listOpeners.mockResolvedValue([])
    await renderControl()
    expect(container.textContent).toContain("未找到可用的打开方式")
    expect(trigger()?.disabled).toBe(true)
  })

  it("saves from the settings page only", async () => {
    await renderControl()
    await act(async () => {
      trigger()?.click()
    })
    const option = [...document.querySelectorAll("[role='option']")].find((node) =>
      node.textContent?.includes("VS Code")
    )
    expect(option, "VS Code option").toBeDefined()
    await act(async () => {
      option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      ;(option as HTMLElement | undefined)?.click()
    })
    expect(updateDefaultOpener).toHaveBeenCalledWith({ defaultOpenerId: "vscode" })
  })

  async function renderControl(): Promise<void> {
    await act(async () => root.render(createElement(DefaultOpenerControl)))
  }

  function trigger(): HTMLButtonElement | null {
    return container.querySelector('button[aria-label="默认文件打开目标"]')
  }
})

const openers: WorkspaceOpener[] = [
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    iconDataUrl: "data:image/png;base64,aaa",
  },
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor",
    iconDataUrl: null,
  },
]

function settingsSnapshot(defaultOpenerId: string | null): DesktopSettingsSnapshot {
  return {
    workStyle: "practical",
    notificationMode: "when_unfocused",
    agentEnvironment: "native",
    showReasoning: true,
    restartRequired: false,
    defaultOpenerId,
    defaultTerminalShellId: null,
  }
}
