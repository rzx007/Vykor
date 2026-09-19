import { describe, expect, it } from "vitest"

import type { DesktopModel } from "@shared/session-types"
import { formatInput, formatReasoning } from "../model-picker"

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
