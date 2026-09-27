import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const stylesheet = readFileSync(new URL("./assets/main.css", import.meta.url), "utf8")
const conversationPage = readFileSync(
  new URL("./components/desktop/conversation-page/conversation-page.tsx", import.meta.url),
  "utf8"
)

describe("Markdown table styles", () => {
  it("flattens Streamdown's table chrome and keeps the data region scrollable", () => {
    expect(stylesheet).toMatch(
      /\[data-streamdown="table-wrapper"\]\s*\{[^}]*display:\s*block;[^}]*overflow:\s*visible;/s
    )
    expect(stylesheet).toMatch(
      /\[data-streamdown="table-wrapper"\]\s*>\s*div:last-child\s*\{[^}]*overflow-x:\s*auto;[^}]*border:\s*0;/s
    )
  })

  it("uses compact rows and lets long table links wrap safely", () => {
    expect(stylesheet).toMatch(
      /\[data-streamdown="table-wrapper"\]\s*td\s*\{[^}]*padding:\s*0\.55rem 0\.75rem;[^}]*overflow-wrap:\s*anywhere;/s
    )
    expect(stylesheet).toMatch(
      /\[data-streamdown="table-wrapper"\]\s+\[data-streamdown="link"\]\s*\{[^}]*word-break:\s*break-word;/s
    )
  })

  it("gives assistant Markdown a wider, compact reading layout", () => {
    expect(conversationPage).toContain("max-w-190")
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="list-item"\]\s*\{[^}]*padding-block:\s*0;/s
    )
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="blockquote"\]\s*\{[^}]*margin:\s*0\.6rem 0;/s
    )
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="link"\]\s*\{[^}]*overflow-wrap:\s*anywhere;/s
    )
  })

  it("keeps the chat reading rhythm for the assistant transcript", () => {
    expect(stylesheet).toMatch(/--chat-font-size:\s*calc\(var\(--ui-font-size\) \+ 1px\);/)
    expect(stylesheet).toMatch(/--chat-line-height:\s*1\.6;/)
    expect(stylesheet).toMatch(/--code-line-height:\s*1\.5;/)
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="heading-2"\]\s*\{[^}]*font-size:\s*var\(--ui-font-size-xl\);[^}]*font-weight:\s*600;/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="strong"\]\s*\{[^}]*font-weight:\s*600;/s
    )
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="paragraph"\]\s*\+\s*\[data-streamdown="paragraph"\]\s*\{[^}]*margin-top:\s*0\.8em;/s
    )
    expect(stylesheet).toMatch(
      /\.assistant-markdown \[data-streamdown="list-item"\]\s*\{[^}]*margin-block:\s*0\.4em;/s
    )
  })
})
