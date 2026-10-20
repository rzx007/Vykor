import { describe, expect, it, vi } from "vitest"

vi.mock("../mermaid-diagram", () => ({ MermaidDiagram: () => null }))

import { streamdownPlugins } from "../streamdown-plugins"

type MdText = { type: "text"; value: string }
type MdLink = { type: "link"; url: string; children: MdText[] }
type MdParent = { type: string; children: MdNode[] }
type MdNode = MdParent | MdText | MdLink
type RemarkPlugin = (...args: unknown[]) => unknown

function applyCjkRemarkPluginsAfter(tree: MdParent): void {
  for (const entry of streamdownPlugins.cjk?.remarkPluginsAfter ?? []) {
    const plugin = (Array.isArray(entry) ? entry[0] : entry) as RemarkPlugin
    const attached = { data: () => ({}), this: undefined }
    const transformer = plugin.call(attached)
    if (typeof transformer === "function") (transformer as (node: MdParent) => void)(tree)
  }
}

function autolinkParagraph(prefix: string, url: string, suffix: string): MdParent {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: prefix },
          { type: "link", url, children: [{ type: "text", value: url }] },
          { type: "text", value: suffix },
        ],
      },
    ],
  }
}

function firstParagraph(tree: MdParent): MdParent {
  return tree.children[0] as MdParent
}

describe("streamdownPlugins CJK autolink boundaries", () => {
  it("enables the CJK plugin so GFM autolinks stop before full-width punctuation", () => {
    expect(streamdownPlugins.cjk?.type).toBe("cjk")
    expect(streamdownPlugins.cjk?.remarkPluginsAfter.length).toBeGreaterThan(0)
  })

  it("splits a full-width parenthesis and the digits after it out of the link", () => {
    const tree = autolinkParagraph(
      "线上已更新：",
      "https://rzx007.github.io/solar-system/（651600",
      " 字节"
    )

    applyCjkRemarkPluginsAfter(tree)

    const paragraph = firstParagraph(tree)
    const link = paragraph.children[1] as MdLink
    expect(link.url).toBe("https://rzx007.github.io/solar-system/")
    expect(link.children[0]?.value).toBe("https://rzx007.github.io/solar-system/")
    expect((paragraph.children[2] as MdText).value).toBe("（651600")
    expect((paragraph.children[3] as MdText).value).toBe(" 字节")
  })

  it("splits a trailing CJK period that swallowed the rest of the sentence", () => {
    const tree = autolinkParagraph(
      "地址是 ",
      "https://rzx007.github.io/solar-system/。等首次构建完成后实际访问验证。",
      ""
    )

    applyCjkRemarkPluginsAfter(tree)

    const paragraph = firstParagraph(tree)
    const link = paragraph.children[1] as MdLink
    expect(link.url).toBe("https://rzx007.github.io/solar-system/")
    expect((paragraph.children[2] as MdText).value).toBe("。等首次构建完成后实际访问验证。")
  })

  it("keeps a URL that legitimately contains CJK path characters intact", () => {
    const url = "https://example.com/路径"
    const tree = autolinkParagraph("地址 ", url, " 结尾")

    applyCjkRemarkPluginsAfter(tree)

    const paragraph = firstParagraph(tree)
    const link = paragraph.children[1] as MdLink
    expect(link.url).toBe(url)
    expect(paragraph.children.length).toBe(3)
  })
})
