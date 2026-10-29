let blockSequence = 0
// 每块仅保留最近的少量动画字符；停顿后整批恢复为普通文本。
export const maxAnimatedCharacters = 512
export const textAnimationMs = 150
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const literalElements = new Set(["pre", "code", "kbd", "samp", "math", "svg", "annotation"])

type TextNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: TextNode[]
}
type AnimatedCharacter = { start: number; end: number }

export class TextAnimationBlock {
  enabled = false
  animateFirst = false
  characters: AnimatedCharacter[] = []
  private previous: string | undefined
  private wasDisabled = false
  private pending = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private mounted = false
  readonly plugin: () => typeof this.transform
  constructor() {
    this.plugin = () => (tree) => this.transform(tree)
    Object.defineProperty(this.plugin, "name", { value: `streamingText${++blockSequence}` })
  }
  configure(enabled: boolean, animateFirst: boolean) {
    if (!enabled) {
      this.previous = undefined
      this.wasDisabled = true
    }
    this.enabled = enabled
    // 关闭期间不跟踪正文；重新启用的第一次解析只建立基线。
    this.animateFirst = animateFirst && !this.wasDisabled
  }
  private clear() {
    this.characters = []
    this.pending = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  commit(refresh: () => void) {
    this.mounted = true
    if (!this.enabled) return this.clear()
    if (!this.characters.length || (!this.pending && this.timer !== null)) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.pending = false
    this.timer = setTimeout(() => {
      this.clear()
      refresh()
    }, textAnimationMs)
  }
  dispose() {
    this.mounted = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    // StrictMode 会同步重放挂载；保留到微任务再释放，既保留基线也不让处理器缓存持有旧正文。
    queueMicrotask(() => {
      if (this.mounted) return
      this.clear()
      this.previous = undefined
    })
  }
  // 插件只遍历当前需要重新解析的块；旧文字只计算长度，不做逐字拆分。
  transform(tree: TextNode) {
    const nodes: Array<{ node: TextNode; parent: TextNode; index: number; start: number }> = []
    const collectFrom =
      this.characters[0]?.start ?? this.previous?.length ?? (this.animateFirst ? 0 : Infinity)
    let plain = ""
    const collect = (parent: TextNode) => {
      if (parent.tagName && literalElements.has(parent.tagName)) return
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.type === "text") {
          const start = plain.length
          plain += node.value ?? ""
          if (plain.length > collectFrom) nodes.push({ node, parent, index, start })
        } else collect(node)
      }
    }
    collect(tree)
    const from = this.previous?.length ?? 0
    // 跨增量补齐组合字形时静置，避免将同一 emoji 拆到不同动画节点。
    const joinsPrevious =
      from > 0 &&
      (/^(?:\p{Mark}|\u200d|\ufe0f|[\u{1F3FB}-\u{1F3FF}])/u.test(plain.slice(from)) ||
        plain[from - 1] === "\u200d")
    const appended =
      !joinsPrevious &&
      (this.previous === undefined ? this.animateFirst : plain.startsWith(this.previous))
    if (!appended || !this.enabled) this.clear()
    if (appended && this.enabled) {
      // 一大批文字只拆尾部有限数量的字符，避免对整个超长字符串做 Segmenter 分词。
      const tail = Math.max(from, plain.length - maxAnimatedCharacters)
      for (const { node, start } of nodes) {
        const value = node.value ?? ""
        const offset = Math.max(0, tail - start)
        if (offset >= value.length) continue
        const scanOffset = Math.max(0, from - start, offset - 64)
        for (const segment of graphemes.segment(value.slice(scanOffset))) {
          if (scanOffset + segment.index < offset) continue
          if (!segment.segment.trim()) continue
          const begin = start + scanOffset + segment.index
          this.characters.push({ start: begin, end: begin + segment.segment.length })
          this.pending = true
        }
      }
      this.characters = this.characters.slice(-maxAnimatedCharacters)
    }
    this.previous = plain
    // 只包装仍有动画的叶子；旧片段不增加 React 组件或清理订阅。
    let characterIndex = 0
    for (const { node, parent, index, start } of nodes) {
      while ((this.characters[characterIndex]?.end ?? Infinity) <= start) characterIndex++
      const character = this.characters[characterIndex]
      if (!character || character.start >= start + (node.value?.length ?? 0)) continue
      parent.children![index] = {
        type: "element",
        tagName: "span",
        properties: { "data-streaming-text-offset": start },
        children: [node],
      }
    }
  }
}
