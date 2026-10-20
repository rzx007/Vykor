// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TitleBar } from "../title-bar"

const titleBarProps = {
  sidebarOpen: true,
  panelOpen: false,
  isMaximized: false,
  hasActiveSession: false,
  canGoBack: false,
  canGoForward: false,
  canOpenPreviousSession: false,
  canOpenNextSession: false,
  zoomLevel: 0,
  onGoBack: vi.fn(),
  onGoForward: vi.fn(),
  onNewConversation: vi.fn(),
  onChooseProject: vi.fn(),
  onCloseConversation: vi.fn(),
  onOpenPreviousSession: vi.fn(),
  onOpenNextSession: vi.fn(),
  onToggleSidebar: vi.fn(),
  onTogglePanel: vi.fn(),
  onOpenUtilityTool: vi.fn(),
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onResetZoom: vi.fn(),
  onMinimize: vi.fn(),
  onToggleMaximize: vi.fn(),
  onClose: vi.fn(),
}

describe("TitleBar window chrome", () => {
  let container: HTMLDivElement
  let root: Root
  const getPlatform = vi.fn()

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Reflect.set(window, "desktop", {
      app: {
        getPlatform,
        getInfo: vi.fn(),
        quit: vi.fn(),
      },
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
    Reflect.deleteProperty(window, "desktop")
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("leaves space for macOS traffic lights and hides custom window buttons", async () => {
    getPlatform.mockResolvedValue({
      platform: "darwin",
      isMac: true,
      isWindows: false,
      isLinux: false,
    })
    await mount()

    expect(container.querySelector("[data-titlebar-traffic-light-space]")).not.toBeNull()
    expect(findButton("最小化")).toBeNull()
    expect(findButton("最大化")).toBeNull()
    expect(findButton("关闭")).toBeNull()
  })

  it("shows custom window buttons on Windows and Linux", async () => {
    getPlatform.mockResolvedValue({
      platform: "win32",
      isMac: false,
      isWindows: true,
      isLinux: false,
    })
    await mount()

    expect(container.querySelector("[data-titlebar-traffic-light-space]")).toBeNull()
    expect(findButton("最小化")).not.toBeNull()
    expect(findButton("最大化")).not.toBeNull()
    expect(findButton("关闭")).not.toBeNull()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(createElement(TitleBar, titleBarProps))
    })
  }
})

function findButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label
    ) ?? null
  )
}
