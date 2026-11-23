// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { TooltipProvider } from "@renderer/components/ui/tooltip"
import type { DesktopWindowMaterialState } from "@shared/window-material-types"
import { APPEARANCE_STORAGE_KEY } from "../appearance-preferences"
import { AppearanceProvider } from "../appearance-provider"
import { AppearanceSettings } from "../appearance-settings"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  localStorage.clear()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderSettings() {
  await act(async () =>
    root.render(
      <AppearanceProvider>
        <TooltipProvider>
          <AppearanceSettings />
        </TooltipProvider>
      </AppearanceProvider>
    )
  )
}

function labeledButton(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

function textButton(text: string, scope: ParentNode = container) {
  return Array.from(scope.querySelectorAll("button")).find((button) => button.textContent === text)
}

function enterColor(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

it("hides every reset entry when the appearance uses defaults", async () => {
  await renderSettings()
  expect(textButton("恢复默认")).toBeUndefined()
  expect(container.querySelector('button[aria-label^="恢复默认"]')).toBeNull()
})

it("treats explicitly saved default colors as defaults", async () => {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      accent: { kind: "custom", value: "#525252" },
      colors: { light: { background: "#FFFFFF" }, dark: { foreground: "#F2F2F2" } },
    })
  )
  await renderSettings()
  expect(textButton("恢复默认")).toBeUndefined()
  expect(container.querySelector('button[aria-label^="恢复默认"]')).toBeNull()
})

it("shows the reset tooltip on hover beside the setting title", async () => {
  await renderSettings()
  act(() => labeledButton("蓝色强调色")!.click())
  const reset = labeledButton("恢复默认强调色")!
  expect(reset.previousElementSibling?.textContent).toBe("强调色")
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => {
    reset.dispatchEvent(new MouseEvent("mouseenter", { clientX: 5, clientY: 5 }))
  })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("恢复默认强调色")
})

it("puts the theme reset beside its title and shows its tooltip on keyboard focus", async () => {
  await renderSettings()
  act(() => labeledButton("深色主题")!.click())
  const reset = labeledButton("恢复默认主题")!
  expect(reset.closest("section")?.querySelector("h2")?.nextElementSibling).toBe(reset)
  expect(reset.textContent).toBe("")
  expect(textButton("恢复默认")).toBeDefined()

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    reset.focus()
  })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("恢复默认主题")
  act(() => reset.click())
  expect(labeledButton("跟随系统主题")?.getAttribute("aria-pressed")).toBe("true")
  expect(labeledButton("恢复默认主题")).toBeNull()
  expect(textButton("恢复默认")).toBeUndefined()
})

it("hides reset entries after typing the original colors back", async () => {
  await renderSettings()
  enterColor("自定义背景色", "#ddeeff")
  expect(labeledButton("恢复默认背景色")).not.toBeNull()
  enterColor("自定义背景色", "#ffffff")
  expect(labeledButton("恢复默认背景色")).toBeNull()
  expect(textButton("恢复默认")).toBeUndefined()

  enterColor("自定义强调色", "#123456")
  expect(labeledButton("恢复默认自定义强调色")).not.toBeNull()
  enterColor("自定义强调色", "#525252")
  expect(labeledButton("恢复默认自定义强调色")).toBeNull()
  expect(textButton("恢复默认")).toBeUndefined()
})

it("finds saved changes in the inactive palette and preserves them when cancelling", async () => {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({ version: 1, colors: { dark: { foreground: "#DDDDEE" } } })
  )
  await renderSettings()
  expect(labeledButton("恢复默认前景色")).toBeNull()

  await act(async () => textButton("恢复默认")!.click())
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("恢复默认外观？")
  await act(async () => textButton("取消", document)!.click())
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).colors.dark.foreground).toBe(
    "#DDDDEE"
  )
  expect(textButton("恢复默认")).toBeDefined()

  await act(async () => textButton("恢复默认")!.click())
  await act(async () => textButton("确认恢复", document)!.click())
  expect(
    JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).colors.dark.foreground
  ).toBeNull()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(textButton("恢复默认")).toBeUndefined()
})

it.each(["Agent 逐字输出动画", "半透明侧边栏"])(
  "resets a switch changed on its own through the page action (%s)",
  async (label) => {
    vi.stubGlobal("electron", { process: { platform: "win32" } })
    const material: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    }
    vi.stubGlobal("desktop", {
      window: {
        material,
        getMaterial: async () => material,
        setMaterial: async (preference: DesktopWindowMaterialState["preference"]) =>
          preference === "glass"
            ? material
            : { preference, active: "opaque", unavailableReason: null, shell: "solid" },
      },
    })

    await renderSettings()
    const toggle = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!
    await act(async () => toggle.click())
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(container.querySelector('button[aria-label^="恢复默认"]')).toBeNull()
    await act(async () => textButton("恢复默认")!.click())
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    await act(async () => textButton("确认恢复", document)!.click())
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(textButton("恢复默认")).toBeUndefined()
  }
)
