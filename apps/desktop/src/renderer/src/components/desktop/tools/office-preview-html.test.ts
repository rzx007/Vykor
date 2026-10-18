// @vitest-environment jsdom
import { expect, it } from "vitest"
import { officePreviewHtml, officePreviewWidth } from "./office-preview-html"
it("isolates generated HTML and disables active content", () => {
  const html = officePreviewHtml(
    '<script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://example.com"><a href="https://example.com">x</a><img src="data:image/png;base64,AA">',
    1
  )
  expect(html).not.toContain("<script")
  expect(html).not.toContain('http-equiv="refresh"')
  expect(html).toContain("script-src 'none'")
  expect(html).toContain("default-src 'none'")
  expect(html).toContain("img-src data:")
  expect(
    new DOMParser().parseFromString(html, "text/html").querySelector("a")?.hasAttribute("inert")
  ).toBe(true)
  expect(officePreviewHtml("x", Number.NaN)).toContain("zoom:1")
})

it("fits the document's design width rather than the exported viewport", () => {
  expect(
    officePreviewWidth(
      '<style>:root{--slide-design-w:960pt}</style><div class="slide"></div>',
      "pptx"
    )
  ).toBe(1304)
  expect(officePreviewWidth('<div class="page" style="width:21cm"></div>', "docx")).toBeCloseTo(
    817.7,
    1
  )
  expect(
    officePreviewWidth(
      '<div class="sheet-content"><table style="width:2000pt"></table></div><div class="sheet-content active"><table style="width:300pt"></table></div>',
      "xlsx"
    )
  ).toBe(424)
})

it("uses the real filename safely and removes duplicate preview chrome", () => {
  const result = officePreviewHtml(
    '<html><head><title>document.xlsx</title></head><body><div class="file-title">document.xlsx</div><p>document.xlsx is a cell value</p></body></html>',
    2.5,
    "预算<&>.xlsx",
    "xlsx"
  )
  const doc = new DOMParser().parseFromString(result, "text/html")
  expect(doc.title).toBe("预算<&>.xlsx")
  expect(doc.querySelector(".file-title")?.textContent).toBe("预算<&>.xlsx")
  expect(doc.querySelector("p")?.textContent).toBe("document.xlsx is a cell value")
  expect(result).toContain("zoom:2.5")
  expect(result).toContain(".file-title")
  expect(doc.querySelectorAll("html")).toHaveLength(1)
})
