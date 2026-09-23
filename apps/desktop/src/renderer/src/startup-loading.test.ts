import { readFileSync } from "node:fs"

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")

describe("startup loading document", () => {
  it("shows an accessible wordmark overlay outside #root", () => {
    const document = new JSDOM(html).window.document
    const loading = document.querySelector("#startup-loading")
    const root = document.querySelector("#root")

    expect(loading?.getAttribute("role")).toBe("status")
    expect(loading?.getAttribute("aria-label")).toBe("正在启动 OpenHarness")
    expect(loading?.textContent).toContain("OpenHarness")
    expect(loading?.querySelectorAll('[data-startup-dot="true"]')).toHaveLength(3)
    expect(root?.contains(loading ?? null)).toBe(false)
    expect(loading?.previousElementSibling).toBe(root)
  })

  it("covers the window as a full-screen overlay after React mounts", () => {
    const styles = new JSDOM(html).window.document.querySelector("style")?.textContent ?? ""

    expect(styles).toContain("position: fixed")
    expect(styles).toContain("inset: 0")
    expect(styles).toContain("z-index: 9999")
  })

  it("遮罩层没有不透明底色，只有中心徽标自带底色", () => {
    const document = new JSDOM(html).window.document
    const styles = document.querySelector("style")?.textContent ?? ""

    expect(styles).toContain("#startup-loading")
    expect(styles).toContain('"Segoe UI Variable Text"')
    expect(styles).not.toMatch(/#startup-loading\s*\{[^}]*background\s*:\s*#/)
    expect(styles).toContain("linear-gradient(180deg, #000000 0%, #151718 100%)")
    expect(styles).toContain("animation: startup-badge-in")
    expect(styles).toContain("prefers-reduced-motion: reduce")
  })

  it("在 React 之前加载已存主题脚本", () => {
    const document = new JSDOM(html).window.document
    const scripts = [...document.querySelectorAll("script")].map((script) =>
      script.getAttribute("src")
    )

    expect(scripts).toContain("./src/startup-theme.ts")
  })
})
