import { describe, expect, it, vi } from "vitest"

import { insertWebviewCssWhenReady } from "../browser-webview-css"

describe("insertWebviewCssWhenReady", () => {
  it("does not call insertCSS before the webview is ready", () => {
    const insertCSS = vi.fn(() => Promise.resolve("key"))

    insertWebviewCssWhenReady({ insertCSS }, "body { color: red }", false)

    expect(insertCSS).not.toHaveBeenCalled()
  })

  it("does not call insertCSS when the webview is missing", () => {
    expect(() => insertWebviewCssWhenReady(null, "body { color: red }", true)).not.toThrow()
  })

  it("injects CSS after the webview is ready", () => {
    const insertCSS = vi.fn(() => Promise.resolve("key"))

    insertWebviewCssWhenReady({ insertCSS }, "body { color: red }", true)

    expect(insertCSS).toHaveBeenCalledWith("body { color: red }")
  })

  it("does not throw when Electron rejects insertCSS before dom-ready", () => {
    const insertCSS = vi.fn(() => {
      throw new Error(
        "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called."
      )
    })

    expect(() => insertWebviewCssWhenReady({ insertCSS }, "body { color: red }", true)).not.toThrow()
  })

  it("swallows a rejected insertCSS promise", async () => {
    const insertCSS = vi.fn(() => Promise.reject(new Error("guest page gone")))

    expect(() => insertWebviewCssWhenReady({ insertCSS }, "body { color: red }", true)).not.toThrow()
    await Promise.resolve()
  })
})
