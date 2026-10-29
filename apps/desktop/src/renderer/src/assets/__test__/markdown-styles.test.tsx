// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { Streamdown } from "streamdown"
import { describe, expect, it } from "vitest"

function readStyles(file: string): string {
  const source = readFileSync(file, "utf8")
  return source.replace(/@import\s+"(\.\/[^"]+)"\s*;/g, (_, path: string) =>
    readStyles(resolve(dirname(file), path))
  )
}

const stylesheet = readStyles(resolve("src/renderer/src/assets/main.css")).replace(
  /\/\*[\s\S]*?\*\//g,
  ""
)
// Check selectors against the library's actual HTML; source-string checks alone missed the old bug.
const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, declarations]) => ({
    selector: selector.trim(),
    declarations,
  })
)

function stylesFor(element: Element): string {
  return rules
    .filter(({ selector }) => {
      if (!selector.includes(".assistant-markdown") && !selector.includes(".desktop-streamdown"))
        return false
      return element.matches(selector)
    })
    .map(({ declarations }) => declarations)
    .join("\n")
}

describe("Markdown paragraph styling", () => {
  it.each(["static", "streaming"] as const)(
    "styles real %s paragraphs without changing their text or Markdown structure",
    (mode) => {
      const container = document.createElement("div")
      container.className = "assistant-markdown"
      container.innerHTML = renderToStaticMarkup(
        <Streamdown mode={mode} className="desktop-streamdown space-y-0">
          {"第一段中文 API。\n\n第二段中文。\n\n- 条目甲\n- 条目乙"}
        </Streamdown>
      )
      const paragraphs = container.querySelectorAll(".desktop-streamdown > p")
      expect([...paragraphs].map((paragraph) => paragraph.textContent)).toEqual([
        "第一段中文 API。",
        "第二段中文。",
      ])
      expect(stylesFor(paragraphs[0]!)).toMatch(/max-width:\s*var\(--markdown-prose-width\)/)
      expect(stylesFor(paragraphs[1]!)).toMatch(/margin-top:\s*var\(--markdown-paragraph-gap\)/)
      expect(container.querySelectorAll("ul > li")).toHaveLength(2)
    }
  )

  it("keeps the message font independent from interface and code fonts", () => {
    const message = document.createElement("div")
    message.className = "assistant-markdown"
    expect(stylesFor(message)).toMatch(/font-family:\s*var\(--font-chat\)/)
    expect(stylesheet).toMatch(/--font-chat:[^;]*Inter Variable[^;]*Noto Sans SC Variable/s)
  })
})
