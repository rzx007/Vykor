import { expect, it } from "vitest"
import { renderUserItems } from "../user-display-items"
import { renderToStaticMarkup } from "react-dom/server"
import { MessagePluginCatalog, PluginMentionIcon } from "../plugin-mention-icon"
import type { DesktopPluginCatalogEntry } from "@shared/session-types"

it("uses the catalog icon and falls back to the same default as the composer", () => {
  const icon = "data:image/png;base64,aGVsbG8="
  const plugins = [{ pluginId: "quality", icon }] as DesktopPluginCatalogEntry[]
  const markup = renderToStaticMarkup(
    <MessagePluginCatalog.Provider value={plugins}>
      <PluginMentionIcon pluginId="quality" />
    </MessagePluginCatalog.Provider>
  )
  expect(markup).toContain(icon)
  expect(markup).toContain("<img")
  expect(markup).toContain('class="mr-1 inline-flex align-middle"')
  expect(renderToStaticMarkup(<PluginMentionIcon pluginId="missing" />)).toContain("lucide-plug")
})

it("restores a historical plugin using its display name", () => {
  expect(
    renderUserItems([
      { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
      { type: "text", text: " review" },
    ])
  ).toEqual([
    { kind: "plugin", name: "dev.quality", displayName: "Quality" },
    { kind: "text", text: " review" },
  ])
})
