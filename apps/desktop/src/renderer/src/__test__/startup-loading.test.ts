import { readFileSync } from "node:fs"

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")

describe("startup loading document", () => {
  it("shows an accessible wordmark overlay outside #root", () => {
    const document = new JSDOM(html).window.document
    const loading = document.querySelector("#startup-loading")
    const root = document.querySelector("#root")

    expect(loading?.getAttribute("role")).toBe("status")
    expect(loading?.getAttribute("aria-label")).toBe("正在启动 Vykor")
    expect(loading?.textContent).toContain("Vykor")
    expect(root?.contains(loading ?? null)).toBe(false)
    expect(loading?.previousElementSibling).toBe(root)
  })

  it("在 React 之前加载已存主题脚本", () => {
    const document = new JSDOM(html).window.document
    const scripts = [...document.querySelectorAll("script")].map((script) =>
      script.getAttribute("src")
    )

    expect(scripts).toContain("./src/startup-theme.ts")
  })
})
