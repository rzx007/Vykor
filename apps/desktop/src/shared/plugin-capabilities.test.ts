import { describe, expect, it } from "vitest"
import { requireDesktopPluginCapabilities } from "./plugin-capabilities"
import { CURRENT_PROTOCOL_VERSION } from "@vykor/application-client"

describe("Desktop plugin capability gate", () => {
  it("accepts the current complete server and rejects incompatible or incomplete servers", () => {
    expect(() => requireDesktopPluginCapabilities({
      serverVersion: "current", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginCapabilities: 1 },
    })).not.toThrow()
    for (const [version, features] of [[CURRENT_PROTOCOL_VERSION - 1, { pluginCapabilities: 1 }], [CURRENT_PROTOCOL_VERSION, {}]] as const) {
      expect(() => requireDesktopPluginCapabilities({ serverVersion: "old", protocol: { version }, features }))
        .toThrow("请同时升级 Desktop 和 daemon")
    }
  })
})
