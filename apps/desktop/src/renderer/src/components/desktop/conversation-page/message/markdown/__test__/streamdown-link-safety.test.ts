import { describe, expect, it } from "vitest"
import { defaultRehypePlugins } from "streamdown"

type Node = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  value?: string
  children?: Node[]
}
type Options = {
  defaultOrigin?: string
  allowedLinkPrefixes?: string[]
  allowedImagePrefixes?: string[]
  allowedProtocols?: string[]
  allowDataImages?: boolean
}
const [harden, defaults] = defaultRehypePlugins.harden as [
  (options: Options) => (tree: Node) => void,
  Options,
]

function checkedUrl(url: string, options: Options = {}, image = false) {
  const tree: Node = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: image ? "img" : "a",
        properties: image ? { src: url, alt: "图片" } : { href: url },
        children: image ? [] : [{ type: "text", value: "链接" }],
      },
    ],
  }
  harden({ ...defaults, ...options })(tree)
  const node = tree.children?.[0]
  return node?.tagName === (image ? "img" : "a")
    ? node.properties?.[image ? "src" : "href"]
    : undefined
}

describe("Streamdown link safety with wildcard prefixes", () => {
  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["http://example.com/docs", "http://example.com/docs"],
    ["./docs/guide.md", "/docs/guide.md"],
    ["/docs/guide.md?lang=zh#intro", "/docs/guide.md?lang=zh#intro"],
    ["#intro", "#intro"],
    ["mailto:user@example.com", "mailto:user@example.com"],
  ])("preserves a permitted URL: %s", (url, expected) => {
    expect(checkedUrl(url)).toBe(expected)
  })

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,evil",
    "vbscript:evil",
    "file:///C:/private.md",
    "not a url",
  ])("rejects unsafe or invalid links even with permissive options: %s", (url) => {
    expect(checkedUrl(url, { allowedProtocols: ["*"] })).toBeUndefined()
  })

  it("keeps explicit prefix restrictions and rejects lookalike hosts", () => {
    const options = {
      defaultOrigin: "https://example.com",
      allowedLinkPrefixes: ["https://example.com/docs/"],
    }
    expect(checkedUrl("https://example.com/docs/intro", options)).toBe(
      "https://example.com/docs/intro"
    )
    expect(checkedUrl("https://example.com/private", options)).toBeUndefined()
    expect(checkedUrl("https://example.com.evil/docs/intro", options)).toBeUndefined()
    expect(checkedUrl("https://example.com@evil.com/docs/intro", options)).toBeUndefined()
  })

  it("keeps wildcard behavior with a base URL and mixed prefix options", () => {
    const options = {
      defaultOrigin: "https://example.com/base/",
      allowedLinkPrefixes: ["https://example.com/docs/", "*"],
    }
    expect(checkedUrl("https://other.example/guide", options)).toBe("https://other.example/guide")
    expect(checkedUrl("./guide", options)).toBe("/base/guide")
    expect(checkedUrl("javascript:alert(1)", options)).toBeUndefined()
  })

  it("keeps image URL and data-image restrictions", () => {
    expect(checkedUrl("https://example.com/image.png", {}, true)).toBe(
      "https://example.com/image.png"
    )
    expect(
      checkedUrl("data:image/png;base64,AAAA", { allowDataImages: false }, true)
    ).toBeUndefined()
    expect(checkedUrl("data:image/png;base64,AAAA", { allowDataImages: true }, true)).toBe(
      "data:image/png;base64,AAAA"
    )
    expect(checkedUrl("data:text/html,evil", { allowDataImages: true }, true)).toBeUndefined()
  })
})
