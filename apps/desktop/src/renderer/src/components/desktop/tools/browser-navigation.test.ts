import { describe, expect, it } from "vitest"

import {
  browserTitleFromUrl,
  displayBrowserUrl,
  normalizeBrowserUrl,
  resolveExternalBrowserUrl,
  toLocalFileUrl,
} from "./browser-navigation"

describe("normalizeBrowserUrl", () => {
  it("converts a Windows absolute path into a file URL", () => {
    expect(normalizeBrowserUrl("D:\\demo site\\index.html")).toBe(
      "file:///D:/demo%20site/index.html"
    )
  })

  it("keeps an existing file URL", () => {
    expect(normalizeBrowserUrl("file:///D:/demo/index.html")).toBe("file:///D:/demo/index.html")
  })

  it("keeps normal web address behavior", () => {
    expect(normalizeBrowserUrl("localhost:5173/demo")).toBe("http://localhost:5173/demo")
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com")
  })
})

describe("toLocalFileUrl", () => {
  it("joins a project root and relative HTML path", () => {
    expect(toLocalFileUrl("D:\\code\\Vykor", "examples/page demo/index.html")).toBe(
      "file:///D:/code/Vykor/examples/page%20demo/index.html"
    )
  })
})

describe("resolveExternalBrowserUrl", () => {
  it("turns the current page or typed address into a system-browser URL", () => {
    expect(resolveExternalBrowserUrl("file:///D:/demo/index.html")).toBe(
      "file:///D:/demo/index.html"
    )
    expect(resolveExternalBrowserUrl("localhost:5173/demo")).toBe("http://localhost:5173/demo")
    expect(resolveExternalBrowserUrl("example.com")).toBe("https://example.com/")
  })

  it("returns null when there is nothing safe to open", () => {
    expect(resolveExternalBrowserUrl(null)).toBeNull()
    expect(resolveExternalBrowserUrl("")).toBeNull()
    expect(resolveExternalBrowserUrl("javascript:alert(1)")).toBeNull()
  })
})

describe("local file address presentation", () => {
  it("keeps the file scheme in the address bar after navigation", () => {
    expect(displayBrowserUrl("file:///D:/demo%20site/index.html")).toBe(
      "file:///D:/demo%20site/index.html"
    )
  })

  it("uses the local filename when the page has no title", () => {
    expect(browserTitleFromUrl("file:///D:/demo%20site/index.html")).toBe("index.html")
  })
})
