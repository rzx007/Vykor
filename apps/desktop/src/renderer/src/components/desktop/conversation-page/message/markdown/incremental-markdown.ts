import { parseMarkdownIntoBlocks } from "streamdown"

// 这些语法可能跨越段落，或被上游规范化；保持 Streamdown 的完整处理方式。
const documentSyntax = /\[\^|^[ \t]{0,3}\[[^\]\n]+\]:|^[ \t]*<|\$\$|\r/m

export function createIncrementalMarkdownParser(): (markdown: string) => string[] {
  let previous: string | undefined
  let blocks: string[] = []
  let stablePrefix = ""
  let stableCount = 0
  let stableLength = 0

  return (markdown) => {
    if (markdown === previous) return blocks
    const sharesPrefix = stablePrefix.length > 0 && markdown.startsWith(stablePrefix)
    const tail = sharesPrefix ? markdown.slice(stablePrefix.length) : markdown
    const fullParse = documentSyntax.test(tail)
    let source = fullParse ? markdown : tail
    let parsed = parseMarkdownIntoBlocks(source)
    let prefixCount = sharesPrefix && !fullParse ? stableCount : 0
    let prefixLength = prefixCount ? stableLength : 0
    // 改写或截断可能清空尾部，需要把此前冻结的末尾也交回完整解析。
    if (prefixCount && parsed.filter((block) => block.trim()).length < 2) {
      source = markdown
      parsed = parseMarkdownIntoBlocks(source)
      prefixCount = 0
      prefixLength = 0
    }
    blocks = prefixCount ? [...blocks.slice(0, prefixCount), ...parsed] : parsed
    previous = markdown
    if (fullParse || parsed.join("") !== source) {
      stablePrefix = ""
      stableCount = 0
      stableLength = 0
      return blocks
    }

    // 保留最后两个非空块重新解析，覆盖列表续写、Setext 标题及未闭合围栏的变化。
    let remaining = 2
    let boundary = parsed.length
    while (boundary > 0 && remaining > 0) {
      boundary--
      if (parsed[boundary]!.trim()) remaining--
    }
    for (let index = 0; index < boundary; index++) {
      const block = parsed[index]!
      // 独立保存新冻结的字符串，避免 V8 子字符串间接保留各个旧版全文。
      blocks[prefixCount + index] = JSON.parse(JSON.stringify(block)) as string
      prefixLength += block.length
    }
    stableCount = prefixCount + boundary
    stableLength = prefixLength
    stablePrefix = markdown.slice(0, stableLength)
    return blocks
  }
}
