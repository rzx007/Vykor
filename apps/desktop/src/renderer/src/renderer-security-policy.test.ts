import { readFileSync } from "node:fs"

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

describe("renderer content security policy", () => {
  it("allows isolated MCP Apps and document previews without opening remote or retired frames", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    const document = new JSDOM(html).window.document
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content")
    const frameSources = policy
      ?.split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === "frame-src")
      ?.slice(1)

    expect(frameSources).toEqual(["'self'", "vykor-plugin-app:", "vykor-preview:"])
  })

  it("allows local blob image previews without allowing remote images", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    const document = new JSDOM(html).window.document
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content")
    const imageSources = policy
      ?.split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === "img-src")
      ?.slice(1)

    expect(imageSources).toContain("blob:")
    expect(imageSources).not.toContain("http:")
    expect(imageSources).not.toContain("https:")
  })
})
