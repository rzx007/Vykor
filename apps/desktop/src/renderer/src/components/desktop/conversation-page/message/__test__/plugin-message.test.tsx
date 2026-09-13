import { expect, it } from "vitest"
import { renderUserItems } from "../message-block"

it("restores a historical plugin using its display name", () => {
  expect(renderUserItems([
    { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
    { type: "text", text: " review" },
  ])).toEqual([
    { kind: "plugin", name: "dev.quality", displayName: "Quality" },
    { kind: "text", text: " review" },
  ])
})
