import { describe, expect, it } from "vitest"
import { requireDesktopPluginCapabilities } from "./plugin-capabilities"

describe("Desktop plugin capability gate", () => {
  it("accepts the current complete server and rejects incompatible or incomplete servers", () => {
    expect(() => requireDesktopPluginCapabilities({
      serverVersion: "current", protocol: { version: 3 }, features: { pluginCapabilities: 1 },
    })).not.toThrow()
    for (const [version, features] of [[2, { pluginCapabilities: 1 }], [3, {}]] as const) {
      expect(() => requireDesktopPluginCapabilities({ serverVersion: "old", protocol: { version }, features }))
        .toThrow("请同时升级 Desktop 和 daemon")
    }
  })
})
