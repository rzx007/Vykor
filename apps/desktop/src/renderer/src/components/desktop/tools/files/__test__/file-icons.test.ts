// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { documentTreeIcons } from "../document-file-icons"
import { File } from "lucide-react"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { getFileIcon } from "../file-icons"
import { preloadFileTree } from "@pierre/trees/ssr"

describe("document file icons", () => {
  it("preserves the tree's colored language icons alongside document overrides", () => {
    const tree = preloadFileTree({ paths: ["index.ts", "app.tsx", "report.pdf"], icons: documentTreeIcons })
    const host = document.createElement("div")
    host.innerHTML = tree.shadowHtml
    expect(host.querySelector('[data-file-tree-colored-icons="true"]')).not.toBeNull()
    expect(host.querySelector('[data-item-path="app.tsx"] use')?.getAttribute("href")).toBe("#file-tree-builtin-react")
    expect(host.querySelector('[data-item-path="report.pdf"] use')?.getAttribute("href")).toBe("#document-pdf")
  })
  it("keeps the tree sprite out of layout without hiding its reusable symbols", () => {
    const host = document.createElement("div")
    host.innerHTML = documentTreeIcons.spriteSheet!
    const sprite = host.querySelector("svg")!
    expect(sprite.style.position).toBe("absolute")
    expect(sprite.getAttribute("width")).toBe("0")
    expect(sprite.getAttribute("height")).toBe("0")
    expect(sprite.querySelectorAll("symbol")).toHaveLength(4)
  })
  it.each([
    ["C:\\reports\\DECK.PPTX", "ppt"],
    ["report.pdf", "pdf"],
    ["letter.docx", "word"],
    ["budget.xlsx", "excel"],
  ])("selects the dedicated file glyph for %s", (name, kind) => {
    const markup = renderToStaticMarkup(createElement(getFileIcon(name)))
    expect(markup).toContain(`data-file-icon="${kind}"`)
    expect(markup).toContain("<path")
  })

  it("uses attachment media type when the filename has no recognized extension", () => {
    expect(getFileIcon("download", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(getFileIcon("deck.pptx"))
    expect(getFileIcon("download", "application/pdf")).toBe(getFileIcon("report.pdf"))
    expect(getFileIcon("unknown.bin")).toBe(File)
  })
})
