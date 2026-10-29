import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const stylesheet = ["main.css", "markdown.css"]
  .map((file) => readFileSync(new URL(`./assets/${file}`, import.meta.url), "utf8"))
  .join("\n")
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
    expect(conversationPage).toContain("conversation-content-column")
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="list-item"\]\s*\{[^}]*padding-block:\s*var\(--markdown-list-item-padding\);/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="blockquote"\]\s*\{[^}]*margin:\s*var\(--markdown-quote-margin\);/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="link"\]\s*\{[^}]*overflow-wrap:\s*anywhere;/s
    )
  })

  it("keeps the chat reading rhythm for the assistant transcript", () => {
    expect(stylesheet).toMatch(/--chat-font-size:\s*calc\(var\(--ui-font-size\) \+ 2px\);/)
    expect(stylesheet).toMatch(/--chat-line-height:\s*1\.7;/)
    expect(stylesheet).toMatch(/--code-line-height:\s*1\.5;/)
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="heading-2"\]\s*\{[^}]*font-size:\s*var\(--markdown-h2-size\);[^}]*font-weight:\s*600;/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="strong"\]\s*\{[^}]*font-weight:\s*600;/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown\s*>\s*p\s*\+\s*p\s*\{[^}]*margin-top:\s*var\(--markdown-paragraph-gap\);/s
    )
    expect(stylesheet).toMatch(
      /\.desktop-streamdown \[data-streamdown="list-item"\]\s*\{[^}]*margin-block:\s*var\(--markdown-list-item-margin\);/s
    )
  })
})
