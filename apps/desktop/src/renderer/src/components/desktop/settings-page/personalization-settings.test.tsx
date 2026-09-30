// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PersonalizationSettings } from "./personalization-settings"

const snapshot = {
  workStyle: "practical",
  notificationMode: "when_unfocused",
  agentEnvironment: "native",
  showReasoning: true,
  browserDeveloperMode: false,
  restartRequired: false,
  defaultOpenerId: null,
  defaultTerminalShellId: null,
  customInstructions: "原来的指令",
  memoryEnabled: true,
  autoExtractEnabled: true,
  wslSupported: false,
} as const

describe("PersonalizationSettings", () => {
  let container: HTMLDivElement
  let root: Root
  const updateCustomInstructions = vi.fn(async ({ content }: { content: string }) => ({
    ...snapshot,
    customInstructions: content,
  }))
  const updateMemorySettings = vi.fn(async ({ enabled }: { enabled: boolean }) => ({
    ...snapshot,
    memoryEnabled: enabled,
  }))

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        settings: {
          snapshot: vi.fn(async () => snapshot),
          updateCustomInstructions,
          updateMemorySettings,
        },
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("loads the memory switches and persists an explicit change", async () => {
    await act(async () => root.render(<PersonalizationSettings />))
    const toggle = container.querySelector<HTMLElement>('[aria-label="项目长期记忆"]')!
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => toggle.click())
    expect(updateMemorySettings).toHaveBeenCalledWith({ enabled: false })
  })

  it("opens the current custom instructions and saves the edited text", async () => {
    await act(async () => root.render(<PersonalizationSettings />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="编辑自定义指令"]')!.click()
    )
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="自定义指令内容"]')!
    expect(textarea.value).toBe("原来的指令")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      setter?.call(textarea, "先说结论")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "保存")!
        .click()
    })
    expect(updateCustomInstructions).toHaveBeenCalledWith({ content: "先说结论" })
  })
})
