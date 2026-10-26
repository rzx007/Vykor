// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { agentAvatarSource } from "../agent-avatar-source"

afterEach(() => vi.unstubAllGlobals())

it("generates a static local SVG without fetching resources", () => {
  const fetch = vi.fn(() => {
    throw new Error("Avatar generation must remain offline")
  })
  vi.stubGlobal("fetch", fetch)
  const source = agentAvatarSource("offline-agent")
  expect(source).toMatch(/^data:image\/svg\+xml[;,]/)
  const svg = decodeURIComponent(source.slice(source.indexOf(",") + 1))
  const document = new DOMParser().parseFromString(svg, "image/svg+xml")
  expect(document.documentElement.localName).toBe("svg")
  expect(
    document.querySelector("parsererror, script, foreignObject, image, animate, animateTransform")
  ).toBeNull()
  expect(svg).not.toContain("@keyframes")
  expect(fetch).not.toHaveBeenCalled()
})

it("keeps the same identity after hundreds of other agents and distinguishes IDs", () => {
  const original = agentAvatarSource("remembered-agent")
  expect(agentAvatarSource("different-agent")).not.toBe(original)
  for (let index = 0; index < 300; index += 1) agentAvatarSource(`agent-${index}`)
  expect(agentAvatarSource("remembered-agent")).toBe(original)
})
