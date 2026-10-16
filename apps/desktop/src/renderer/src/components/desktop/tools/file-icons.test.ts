import { describe, expect, it } from "vitest"
import { File } from "lucide-react"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { getFileIcon } from "./file-icons"

describe("document file icons", () => {
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
