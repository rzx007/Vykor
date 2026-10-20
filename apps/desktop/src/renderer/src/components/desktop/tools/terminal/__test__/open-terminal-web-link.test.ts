// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

import { openTerminalWebLink } from "../open-terminal-web-link"

describe("openTerminalWebLink", () => {
  it("opens http(s) links through the desktop external opener", () => {
    const openExternal = vi.fn(async () => undefined)
    Reflect.set(window, "desktop", { window: { openExternal } })

    openTerminalWebLink("https://example.com/docs")

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
  })
})
