import { renderToStaticMarkup } from "react-dom/server"
import { createEditor } from "lexical"
import { expect, test } from "vitest"
import { PluginMentionIcons, PluginMentionNode } from "../plugin-mention-node"

test("renders a plugin icon instead of @ and preserves the reference and icon", () => {
  const editor = createEditor({ nodes: [PluginMentionNode], onError: (error) => { throw error } })
  editor.update(
    () => {
      const item = {
        type: "capability" as const,
        kind: "plugin" as const,
        pluginId: "reviewer",
        displayName: "Reviewer",
      }
      const icon = "data:image/png;base64,aGVsbG8="
      const node = new PluginMentionNode(item, undefined, icon)
      const restored = PluginMentionNode.importJSON(node.exportJSON())
      const markup = renderToStaticMarkup(restored.decorate())
      expect(markup).toContain(`<img`)
      expect(markup).toContain(icon)
      expect(markup).toContain('class="mr-1 inline-flex align-middle"')
      expect(markup).not.toContain("@Reviewer")
      expect(restored.getTextContent()).toBe("@Reviewer")
      expect(restored.exportJSON().item).toEqual(item)
      expect(PluginMentionNode.clone(node).exportJSON().icon).toBe(icon)
      const fromDraft = new PluginMentionNode(item)
      const draftMarkup = renderToStaticMarkup(
        <PluginMentionIcons.Provider value={new Map([[item.pluginId, icon]])}>
          {fromDraft.decorate()}
        </PluginMentionIcons.Provider>
      )
      expect(draftMarkup).toContain(icon)
      expect(fromDraft.exportJSON().item).toEqual(item)
      const fallback = renderToStaticMarkup(new PluginMentionNode(item).decorate())
      expect(fallback).toContain("lucide-plug")
      expect(fallback).toContain('class="mr-1 inline-flex align-middle"')
      expect(fallback).toContain("Reviewer")
    },
    { discrete: true }
  )
})
