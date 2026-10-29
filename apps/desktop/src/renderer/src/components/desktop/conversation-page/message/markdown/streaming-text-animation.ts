let blockSequence = 0
// 只给解析后的新增文本分配短期动画额度，不缓存旧版全文或逐字历史。
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
export type AnimatedCharacter = { id: number; start: number; end: number }

export class TextAnimationPool {
  lastBlockIndex = -1
  initialBlocks: number | null = null
  private sequence = 0
  private leases = new Map<number, number>()
  private active = new Set<TextAnimationBlock>()
  private timer: ReturnType<typeof setTimeout> | null = null

  available() {
    this.expire()
    return maxAnimatedCharacters - this.leases.size
  }
  reserve(start: number, end: number): AnimatedCharacter | undefined {
    if (this.leases.size >= maxAnimatedCharacters) return
    const id = ++this.sequence
    this.leases.set(id, performance.now() + textAnimationMs)
    return { id, start, end }
  }
  has(id: number) {
    return this.leases.has(id)
  }
  release(id: number) {
    this.leases.delete(id)
  }
  private expire() {
    const now = performance.now()
    for (const [id, deadline] of this.leases) if (deadline <= now) this.leases.delete(id)
  }
  commit(block: TextAnimationBlock) {
    this.active.add(block)
    this.expire()
    for (const item of this.active) {
      item.prune()
      if (!item.characters.length) this.active.delete(item)
    }
    this.schedule()
  }
  remove(block: TextAnimationBlock) {
    this.active.delete(block)
    for (const character of block.characters) this.release(character.id)
    this.schedule()
  }
  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.leases.size || !this.active.size) return
    const deadline = Math.min(...this.leases.values())
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.expire()
        for (const item of this.active) {
          item.prune()
          if (!item.characters.length) this.active.delete(item)
        }
        this.schedule()
      },
      Math.max(1, deadline - performance.now())
    )
  }
}

export class TextAnimationBlock {
  enabled = false
  animateFirst = false
  characters: AnimatedCharacter[] = []
  private previous: string | undefined
  private version = 0
  private mounted = false
  private listeners = new Set<() => void>()
  readonly plugin: () => typeof this.transform
  constructor(readonly pool: TextAnimationPool) {
    this.plugin = () => this.transform
    Object.defineProperty(this.plugin, "name", { value: `streamingText${++blockSequence}` })
  }
  configure(enabled: boolean, animateFirst: boolean) {
    this.enabled = enabled
    this.animateFirst = animateFirst
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.version
  private clear() {
    for (const character of this.characters) this.pool.release(character.id)
    this.characters = []
  }
  prune() {
    const kept = this.characters.filter((c) => this.pool.has(c.id))
    if (kept.length === this.characters.length) return
    this.characters = kept
    this.version++
    for (const listener of this.listeners) listener()
  }
  commit() {
    this.mounted = true
    if (!this.enabled) {
      this.clear()
      this.version++
      for (const listener of this.listeners) listener()
    }
    this.pool.commit(this)
  }
  dispose() {
    this.mounted = false
    this.pool.remove(this)
    // StrictMode 会同步重放挂载；保留到微任务再释放，既保留基线也不让处理器缓存持有旧正文。
    queueMicrotask(() => {
      if (this.mounted) return
      this.characters = []
      this.previous = undefined
    })
  }
  // 插件只遍历当前需要重新解析的块；旧文字只计算长度，不做逐字拆分。
  transform = (tree: TextNode) => {
    const nodes: Array<{ node: TextNode; parent: TextNode; index: number; start: number }> = []
    let plain = ""
    const collect = (parent: TextNode) => {
      if (parent.tagName && literalElements.has(parent.tagName)) return
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.type === "text") {
          nodes.push({ node, parent, index, start: plain.length })
          plain += node.value ?? ""
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
      const tail = Math.max(from, plain.length - this.pool.available())
      for (const { node, start } of nodes) {
        const value = node.value ?? ""
        const offset = Math.max(0, tail - start)
        if (offset >= value.length) continue
        const scanOffset = Math.max(0, from - start, offset - 64)
        for (const segment of graphemes.segment(value.slice(scanOffset))) {
          if (scanOffset + segment.index < offset) continue
          if (!segment.segment.trim()) continue
          const begin = start + scanOffset + segment.index
          const character = this.pool.reserve(begin, begin + segment.segment.length)
          if (character) this.characters.push(character)
        }
      }
    }
    this.previous = plain
    this.version++
    // 包装的是 AST 文本叶子；链接、强调、列表和代码的结构不变。
    for (const { node, parent, index, start } of nodes) {
      parent.children![index] = {
        type: "element",
        tagName: "span",
        properties: { "data-streaming-text-offset": start },
        children: [node],
      }
    }
  }
}
