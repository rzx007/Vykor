import { bench, describe } from "vitest"
import { parseMarkdownIntoBlocks } from "streamdown"
import { createIncrementalMarkdownParser } from "../incremental-markdown"

const initial =
  Array.from(
    { length: 1000 },
    (_, index) => `第 ${index} 段：已经显示的 **Markdown** 内容。\n\n`
  ).join("") + "末尾"
const updates: string[] = []
let source = initial
for (let index = 0; index < 100; index++) {
  source += index % 10 === 0 ? "\n\n新段落" : "追加内容"
  updates.push(source)
}

describe("1000 paragraphs / 100 streaming updates (real Streamdown lexer)", () => {
  const options = { time: 300, iterations: 5, warmupTime: 100, warmupIterations: 2 }
  bench(
    "full reply on every update",
    () => {
      for (const text of updates) parseMarkdownIntoBlocks(text)
    },
    options
  )
  bench(
    "incremental tail including the initial parse",
    () => {
      const parse = createIncrementalMarkdownParser()
      parse(initial)
      for (const text of updates) parse(text)
    },
    options
  )
})
