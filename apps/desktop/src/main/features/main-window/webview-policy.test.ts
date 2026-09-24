import { describe, expect, it } from "vitest"

import { isAllowedWebviewUrl } from "./webview-policy"

describe("isAllowedWebviewUrl", () => {
  it("allows local file URLs in the Vykor browser", () => {
    expect(isAllowedWebviewUrl("file:///D:/demo/index.html")).toBe(true)
  })

  it("continues to reject unsupported protocols", () => {
    expect(isAllowedWebviewUrl("javascript:alert(1)")).toBe(false)
  })
})
