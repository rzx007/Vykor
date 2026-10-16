import { expect, it } from "vitest"
import { officePreviewHtml } from "./office-preview-html"
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
  expect(html).toContain("<a inert")
  expect(officePreviewHtml("x", 100)).toContain("zoom:2")
})
