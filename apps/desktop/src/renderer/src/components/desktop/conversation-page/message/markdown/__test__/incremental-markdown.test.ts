import { beforeEach, expect, it, vi } from "vitest"
import { parseMarkdownIntoBlocks } from "streamdown"
import { createIncrementalMarkdownParser } from "../incremental-markdown"

const measured = vi.hoisted(() => ({ inputLengths: [] as number[] }))
vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>()
  return {
    ...actual,
    parseMarkdownIntoBlocks: (text: string) => {
      measured.inputLengths.push(text.length)
      return actual.parseMarkdownIntoBlocks(text)
    },
  }
})
beforeEach(() => measured.inputLengths.splice(0))

it.each([
  "# 标题\n\n段落 **加粗** 和 [链接](https://example.com)。\n\n第二段\n\n后续文字",
  "开始\n\n- 列表一\n\n  列表中的段落\n\n- 列表二\n\n后续段落\n\n尾部",
  "开头\n\n```ts\nconst text = `空行\n\n仍在代码中`;\n```\n\n后续\n\n末尾",
  "段落\n\n| 名称 | 值 |\n| --- | --- |\n| a | b |\n\n下一段\n\n尾部",
  "> 引用\n>\n> - 嵌套列表\n> - 项目二\n\n正文\n\n末尾",
  "第一段\n\n第二段\n\n标题\n-----\n\n新段落",
  "[链接][target]\n\n已有段落\n\n[target]: https://example.com\n\n结尾",
  "脚注[^note]\n\n已有段落\n\n[^note]: 注释内容\n\n结尾",
  "<section>\n\nHTML 内的段落\n\n</section>\n\n后续",
  "正文\n\n$$\na+b\n\n=c\n$$\n\n下一段",
  "段落一\r\n\r\n段落二\r\n\r\n结尾",
  "保留代理项\ud800\n\n第二段\udc00\n\n第三段\n\n末尾",
])("matches Streamdown for every streamed prefix: %s", (source) => {
  const parse = createIncrementalMarkdownParser()
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end)
    expect(parse(prefix)).toEqual(parseMarkdownIntoBlocks(prefix))
  }
})

it("rebuilds after a correction, truncation or a repaired incomplete Markdown suffix", () => {
  const parse = createIncrementalMarkdownParser()
  for (const source of [
    "首段\n\n第二段\n\n**未完成**",
    "首段\n\n第二段\n\n**未完成追加**",
    "首段\n\n改写第二段\n\n新结尾",
    "首段",
    "",
    "全新的内容",
  ]) {
    expect(parse(source)).toEqual(parseMarkdownIntoBlocks(source))
  }
})

it("does not lex an unchanged reply again", () => {
  const parse = createIncrementalMarkdownParser()
  const text = "已经完成的段落\n\n末尾"
  parse(text)
  measured.inputLengths.splice(0)
  parse(text)
  expect(measured.inputLengths).toEqual([])
})

it("bounds lexing work to the changing tail of a thousand-paragraph reply", () => {
  const parse = createIncrementalMarkdownParser()
  let text =
    Array.from(
      { length: 1000 },
      (_, index) => `第 ${index} 段：已经显示的 **Markdown** 内容。\n\n`
    ).join("") + "末尾"
  const initialLength = text.length
  parse(text)
  measured.inputLengths.splice(0)
  let output: string[] = []
  for (let index = 0; index < 100; index++) {
    text += index % 10 === 0 ? "\n\n新段落" : "追加内容"
    output = parse(text)
  }
  const lexedCharacters = measured.inputLengths.reduce((sum, length) => sum + length, 0)
  expect(output).toEqual(parseMarkdownIntoBlocks(text))
  expect(lexedCharacters).toBeLessThan(initialLength * 5)
})
