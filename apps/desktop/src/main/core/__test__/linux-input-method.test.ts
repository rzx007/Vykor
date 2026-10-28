import { describe, expect, it } from "vitest"
import { configureLinuxInputMethod } from "../linux-input-method"

function switches(initial: Record<string, string | undefined> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    appendSwitch(name: string, value?: string) { values.set(name, value) },
    hasSwitch(name: string) { return values.has(name) },
  }
}

describe("configureLinuxInputMethod", () => {
  it("enables the system input method connection on Linux", () => {
    const commandLine = switches()
    configureLinuxInputMethod(commandLine, "linux")
    expect(commandLine.values.has("enable-wayland-ime")).toBe(true)
  })

  it.each(["win32", "darwin"] as const)("does not add Linux switches on %s", (platform) => {
    const commandLine = switches()
    configureLinuxInputMethod(commandLine, platform)
    expect(commandLine.values.size).toBe(0)
  })

  it.each(["x11", "wayland"])("preserves an explicit %s display backend", (backend) => {
    const commandLine = switches({ "ozone-platform": backend })
    configureLinuxInputMethod(commandLine, "linux")
    expect(commandLine.values.get("ozone-platform")).toBe(backend)
  })
})
