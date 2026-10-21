import { expect, it } from "vitest"
import { PluginAppModelContexts } from "../plugin-app-model-context"

it("keeps context separate from composer text, scoped to the original session and removable", () => {
  const contexts = new PluginAppModelContexts()
  const draft = "already typed"
  contexts.put({ id: "one", source: { sessionId: "hidden", appId: "a" }, pluginId: "test", text: "selection", data: { selected: 1 } })
  expect(draft).toBe("already typed")
  expect(contexts.forSession("current")).toEqual([])
  expect(contexts.forSession("hidden")).toHaveLength(1)
  contexts.remove("one")
  expect(contexts.forSession("hidden")).toEqual([])
})
it("clears only submitted versions, preserving context updated while sending", () => {
  const contexts = new PluginAppModelContexts()
  const first = { id: "one", source: { sessionId: "s", appId: "a" }, pluginId: "test", text: "first", data: null }
  contexts.put(first)
  contexts.put({ ...first, id: "two", text: "second" })
  contexts.remove(first.id)
  expect(contexts.forSession("s").map(item => item.text)).toEqual(["second"])
})
