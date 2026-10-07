import { describe, expect, it } from "vitest"

import {
  defaultSettingsSection,
  isSettingsSection,
  settingsSectionLabel,
  settingsSectionSlug,
} from "./settings-navigation"

describe("settings navigation", () => {
  it("maps stable URL segments to localized labels", () => {
    expect(settingsSectionLabel("appearance")).toBe("外观")
    expect(settingsSectionSlug("外观")).toBe("appearance")
    expect(settingsSectionLabel("providers")).toBe("模型供应商")
    expect(settingsSectionSlug("模型供应商")).toBe("providers")
    expect(settingsSectionLabel("storage")).toBe("存储")
    expect(settingsSectionSlug("存储")).toBe("storage")
    expect(isSettingsSection("storage")).toBe(true)
    expect(settingsSectionLabel("notifications")).toBe("通知")
    expect(settingsSectionSlug("通知")).toBe("notifications")
    expect(isSettingsSection("notifications")).toBe(true)
    expect(isSettingsSection("plugins")).toBe(false)
  })

  it("falls back to general for an unknown section", () => {
    expect(isSettingsSection("missing")).toBe(false)
    expect(settingsSectionLabel("missing")).toBe("常规")
    expect(settingsSectionSlug("不存在")).toBe(defaultSettingsSection)
  })
})
