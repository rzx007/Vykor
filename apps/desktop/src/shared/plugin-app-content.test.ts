import { expect, it } from "vitest"
import { pluginAppText, pluginAppContextData } from "./plugin-app-content"
it("counts Unicode code points, refuses unsupported blocks and bounds structured JSON to 32 KiB", () => {
  expect(pluginAppText([{ type: "text", text: "😀".repeat(4096) }])).toHaveLength(8192)
  expect(() => pluginAppText([{ type: "text", text: "😀".repeat(4097) }])).toThrow()
  expect(() => pluginAppText([{ type: "image", data: "image" }])).toThrow()
  expect(() => pluginAppContextData({ text: "x".repeat(32768) })).toThrow()
  expect(pluginAppContextData({ text: "x".repeat(32757) })).toEqual({ text: "x".repeat(32757) })
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => pluginAppContextData(cyclic)).toThrow()
})
