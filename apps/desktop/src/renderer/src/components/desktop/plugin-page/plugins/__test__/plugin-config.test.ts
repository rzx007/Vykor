import { describe, expect, it } from "vitest"
import {
  parsePluginConfig,
  pluginConfigKey,
  readPluginConfigs,
  savePluginConfigs,
} from "../plugin-config"

describe("plugin configuration", () => {
  it("keeps additional manifest fields during import", () => {
    expect(
      parsePluginConfig('{"name":"example","mcpServers":{"docs":{"command":"node"}}}')
    ).toHaveProperty("mcpServers.docs.command", "node")
  })
  it("rejects stale writes without overwriting a second window", () => {
    let raw = "changed by another window"
    expect(() =>
      savePluginConfigs(
        {
          getItem: () => raw,
          setItem: (_, value) => {
            raw = value
          },
        },
        "key",
        [],
        null
      )
    ).toThrow("其他窗口")
    expect(raw).toBe("changed by another window")
  })
  it("accepts a minimal manifest and fills display defaults", () => {
    expect(parsePluginConfig('{"name":" example "}')).toEqual({
      name: "example",
      description: "",
      source: "",
      version: "1.0.0",
    })
  })
  it.each(["[]", "null", '{"name":" "}', '{"name":"test","version":2}', "{"])(
    "rejects invalid input %s",
    (text) => {
      expect(() => parsePluginConfig(text)).toThrow()
    }
  )
  it("does not silently reset corrupt saved data", () => {
    expect(() => readPluginConfigs({ getItem: () => '{"version":2,"items":[]}' }, "key")).toThrow()
  })
  it("restores disabled records and scopes drafts to the project", () => {
    const saved = JSON.stringify({
      version: 1,
      items: [{ id: "one", name: "test", enabled: false }],
    })
    expect(readPluginConfigs({ getItem: () => saved }, "key")[0].enabled).toBe(false)
    expect(pluginConfigKey("project-a")).not.toBe(pluginConfigKey("project-b"))
  })
})
