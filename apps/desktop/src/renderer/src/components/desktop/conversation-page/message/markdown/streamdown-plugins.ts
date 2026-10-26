import { cjk } from "@streamdown/cjk"
import { defaultRehypePlugins, type CustomRenderer, type PluginConfig } from "streamdown"

import { MermaidDiagram } from "./mermaid-diagram"
import { parseFileReference } from "../models/message-render-model"

type LinkNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: (LinkNode | null | undefined)[]
}

const relativeFileHrefs = new WeakMap<LinkNode, string>()

function visitLinks(
  node: LinkNode | null | undefined,
  visit: (node: LinkNode, href: string) => void
): void {
  if (!node) return
  if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string")
    visit(node, node.properties.href)
  for (const child of node.children ?? []) visitLinks(child, visit)
}

function prepareRelativeFileLinks() {
  return (tree: LinkNode) =>
    visitLinks(tree, (node, href) => {
      let decoded: string
      try {
        decoded = decodeURIComponent(href)
      } catch {
        return
      }
      if (
        !parseFileReference(href) ||
        /^(?:[a-z][a-z0-9+.-]*:|[\\/]|\.{1,2}[\\/]|[#?])/i.test(decoded.trim()) ||
        /[\u0000-\u001f\u007f]/.test(decoded) ||
        decoded.split(/[\\/]/).includes("..")
      )
        return
      // 保留前面 sanitizer 的清理结果，补足相对文件语法后仍交给 harden 检查。
      relativeFileHrefs.set(node, href)
      node.properties!.href = `./${href}`
    })
}

function restoreRelativeFileLinks() {
  return (tree: LinkNode) =>
    visitLinks(tree, (node) => {
      const href = relativeFileHrefs.get(node)
      if (href === undefined) return
      // harden 拒绝的节点已被移出树；只恢复仍然存活的链接，防止变成磁盘根路径。
      node.properties!.href = href
      relativeFileHrefs.delete(node)
    })
}

export const streamdownRehypePlugins = Object.entries(defaultRehypePlugins).flatMap(
  ([name, plugin]) =>
    name === "harden" ? [prepareRelativeFileLinks, plugin, restoreRelativeFileLinks] : [plugin]
)

const customRenderers: CustomRenderer[] = [
  {
    component: MermaidDiagram,
    language: ["mermaid", "mmd"],
  },
]

const cspSafeCodeHighlighter: NonNullable<PluginConfig["code"]> = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => [],
  getThemes: () => ["github-light", "github-dark"],
  supportsLanguage: () => false,
  highlight: () => null,
}

export const streamdownPlugins: PluginConfig = {
  cjk,
  code: cspSafeCodeHighlighter,
  renderers: customRenderers,
}
