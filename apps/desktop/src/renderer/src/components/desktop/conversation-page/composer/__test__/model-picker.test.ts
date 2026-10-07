// @vitest-environment jsdom

import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopModel } from "@shared/session-types"
import { formatInput, formatReasoning, ModelPicker } from "../model-picker"

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}))

function model(image: "native" | "unsupported" | "unknown"): DesktopModel {
  return {
    id: "custom-model",
    label: "Custom",
    provider: "Mine",
    providerName: "mine",
    inputCapabilities: { image },
  }
}

describe("model picker input capabilities", () => {
  it("shows all three canonical image states", () => {
    expect(formatInput(model("native"))).toBe("文本、图像")
    expect(formatInput(model("unsupported"))).toBe("文本（不支持图像）")
    expect(formatInput(model("unknown"))).toBe("文本（图像能力未知）")
  })

  it("prefers catalog input modalities when present", () => {
    expect(formatInput({ ...model("unknown"), inputModalities: ["text", "image"] })).toBe(
      "文本、图像"
    )
  })
})

describe("model picker reasoning tiers", () => {
  it("lists declared effort tiers", () => {
    expect(
      formatReasoning({ ...model("native"), reasoning: true, reasoningEfforts: ["low", "high", "max"] })
    ).toBe("支持推理（low / high / max）")
  })

  it("falls back to plain support without tiers", () => {
    expect(formatReasoning({ ...model("native"), reasoning: true })).toBe("支持推理")
    expect(formatReasoning({ ...model("native"), reasoning: false })).toBe("不支持推理")
    expect(formatReasoning(model("native"))).toBe("—")
  })
})

describe("model picker provider settings shortcut", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    navigate.mockClear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  })

  it("navigates to model provider settings when clicked", async () => {
    function PickerHarness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return createElement(ModelPicker, {
        open,
        onOpenChange: setOpen,
        models: [],
        selectedModel: null,
        selectedProvider: null,
        modelLabel: "模型",
        onSelectModel: vi.fn(),
      })
    }

    await act(async () => root.render(createElement(PickerHarness)))
    const trigger = container.querySelector("button")
    await act(async () => trigger?.click())
    const manageButton = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("模型管理")
    )

    expect(manageButton?.disabled).toBe(false)
    await act(async () => manageButton?.click())
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/$section",
      params: { section: "providers" },
    })
  })
})
