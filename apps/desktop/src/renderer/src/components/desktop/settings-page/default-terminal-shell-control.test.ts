// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSettingsSnapshot } from "@shared/settings-types"
import type { DesktopDetectedTerminalShell } from "@shared/terminal-types"

import { DefaultTerminalShellControl } from "./default-terminal-shell-control"

describe("DefaultTerminalShellControl", () => {
  let container: HTMLDivElement
  let root: Root
  let snapshot: ReturnType<typeof vi.fn>
  let updateDefaultTerminalShell: ReturnType<typeof vi.fn>
  let listShells: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    snapshot = vi.fn(async () => settingsSnapshot(null))
    updateDefaultTerminalShell = vi.fn(async (input: { defaultTerminalShellId: string | null }) =>
      settingsSnapshot(input.defaultTerminalShellId)
    )
    listShells = vi.fn(async () => shells)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        settings: { snapshot, updateDefaultTerminalShell },
        terminal: { listShells },
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

  it("renders system default and detected shells instead of a hardcoded PowerShell button", async () => {
    await renderControl()
    expect(trigger()?.textContent).toContain("系统默认")
    expect(trigger()?.textContent).not.toBe("PowerShell")
    await openSelect()
    expect(document.body.textContent).toContain("系统默认")
    expect(document.body.textContent).toContain("PowerShell 7")
  })

  it("falls back to system default when the saved id is gone", async () => {
    snapshot.mockResolvedValue(settingsSnapshot("git-bash"))
    await renderControl()
    expect(trigger()?.textContent).toContain("系统默认")
  })

  it("saves a detected shell from the settings page", async () => {
    await renderControl()
    await chooseOption("PowerShell 7")
    expect(updateDefaultTerminalShell).toHaveBeenCalledWith({ defaultTerminalShellId: "pwsh" })
  })

  it("saves system default as null", async () => {
    snapshot.mockResolvedValue(settingsSnapshot("pwsh"))
    await renderControl()
    expect(trigger()?.textContent).toContain("PowerShell 7")
    await chooseOption("系统默认")
    expect(updateDefaultTerminalShell).toHaveBeenCalledWith({ defaultTerminalShellId: null })
  })

  it("keeps system default selectable when no shells are installed", async () => {
    listShells.mockResolvedValue([])
    await renderControl()
    expect(container.textContent).toContain("系统默认")
    expect(trigger()?.disabled).toBe(false)
  })

  it("keeps system default selectable when listing shells fails", async () => {
    listShells.mockRejectedValue(new Error("list failed"))
    await renderControl()
    expect(container.textContent).toContain("系统默认")
    expect(trigger()?.disabled).toBe(false)
  })

  it("rolls back the trigger and shows an error when save fails", async () => {
    snapshot.mockResolvedValue(settingsSnapshot("pwsh"))
    updateDefaultTerminalShell.mockRejectedValue(new Error("save failed"))
    await renderControl()
    expect(trigger()?.textContent).toContain("PowerShell 7")
    await chooseOption("系统默认")
    expect(trigger()?.textContent).toContain("PowerShell 7")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("save failed")
  })

  async function renderControl(): Promise<void> {
    await act(async () => root.render(createElement(DefaultTerminalShellControl)))
  }

  function trigger(): HTMLButtonElement | null {
    return container.querySelector('button[aria-label="集成终端 Shell"]')
  }

  async function openSelect(): Promise<void> {
    await act(async () => {
      trigger()?.click()
    })
  }

  async function chooseOption(label: string): Promise<void> {
    await openSelect()
    const option = [...document.querySelectorAll("[role='option']")].find((node) =>
      node.textContent?.includes(label)
    )
    expect(option, `${label} option`).toBeDefined()
    await act(async () => {
      option?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      ;(option as HTMLElement | undefined)?.click()
    })
  }
})

const shells: DesktopDetectedTerminalShell[] = [
  { id: "pwsh", label: "PowerShell 7" },
  { id: "cmd", label: "命令提示符" },
]

function settingsSnapshot(defaultTerminalShellId: string | null): DesktopSettingsSnapshot {
  return {
    workStyle: "practical",
    notificationMode: "when_unfocused",
    agentEnvironment: "native",
    showReasoning: true,
    restartRequired: false,
    defaultOpenerId: null,
    defaultTerminalShellId,
  }
}
