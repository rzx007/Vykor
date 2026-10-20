import { describe, expect, it } from "vitest"

import { buildBrowserScrollbarCss } from "../browser-webview-style"

describe("buildBrowserScrollbarCss", () => {
  it("uses the C-level low-emphasis colors in light pages", () => {
    const css = buildBrowserScrollbarCss("light")

    expect(css).toContain("color-scheme: light")
    expect(css).toContain("rgb(20 27 33 / 8%)")
    expect(css).toContain("rgb(20 27 33 / 16%)")
    expect(css).toContain("::-webkit-scrollbar-thumb")
  })

  it("uses the C-level low-emphasis colors in dark pages", () => {
    const css = buildBrowserScrollbarCss("dark")

    expect(css).toContain("color-scheme: dark")
    expect(css).toContain("rgb(245 247 249 / 10%)")
    expect(css).toContain("rgb(245 247 249 / 18%)")
    expect(css).toContain("::-webkit-scrollbar-thumb:hover")
  })
})
