import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConversationTranscriptSkeleton } from "../conversation-transcript-skeleton"

describe("ConversationTranscriptSkeleton", () => {
  it("renders a conversation-shaped skeleton without visible loading copy", () => {
    const html = renderToStaticMarkup(createElement(ConversationTranscriptSkeleton))

    expect(html).toContain('aria-label="正在加载会话"')
    expect(html).toContain("aria-busy")
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain('data-align="end"')
    expect(html.match(/data-slot="skeleton"/g)?.length).toBeGreaterThan(3)
    expect(html).not.toContain("正在加载会话</")
  })
})
