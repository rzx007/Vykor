// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { conversationMatchRanges, observeConversationMatch } from "../conversation-find-highlight"

afterEach(() => vi.unstubAllGlobals())

it("highlights matches across inline nodes without changing markup or copied text", () => {
  const root = document.createElement("div")
  root.innerHTML = "你好 <strong>Open</strong>AI 和 OpenAI <button>OpenAI</button>"
  const before = root.innerHTML
  const ranges = conversationMatchRanges(root, ["openai"])
  expect(ranges.map((range) => range.toString())).toEqual(["OpenAI", "OpenAI"])
  expect(root.innerHTML).toBe(before)
})

it("selects final-answer text rather than an earlier process from the same message", () => {
  const viewport = document.createElement("div")
  viewport.innerHTML = `<div data-chat-search-messages='["a"]'><p data-chat-search-text data-chat-search-message="a" data-chat-search-parts='["process"]'>earlier</p></div><div data-chat-search-messages='["a"]'><p data-chat-search-text data-chat-search-message="a" data-chat-search-parts='["final"]'>needle</p></div>`
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  const cleanup = observeConversationMatch(
    viewport,
    { messageId: "a", partIds: ["final"], tokens: ["needle"] },
    "test-find",
    () => {}
  )
  frames.shift()!(0)
  expect(viewport.querySelector("[data-search-active=true]")?.textContent).toBe("needle")
  cleanup()
  vi.unstubAllGlobals()
})
