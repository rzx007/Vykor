// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Streamdown, defaultRemarkPlugins, defaultRehypePlugins } from "streamdown"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@renderer/components/ui/code-block", () => ({ CodeBlock: () => null }))
vi.mock("../mermaid-diagram", () => ({ MermaidDiagram: () => null }))

import { AssistantMarkdown } from "../assistant-markdown"

type MarkdownNode = {
  type: string
  spread?: boolean | null
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}
let inspectTree: (tree: MarkdownNode) => void = () => {}
// 使用真实解析和转换，只在转换前观测输入；固定插件身份避免处理器缓存混用测试闭包。
function observeListConversion() {
  return (tree: MarkdownNode) => inspectTree(tree)
}
const remarkPlugins = [...Object.values(defaultRemarkPlugins), observeListConversion]
let convertedShape: ReturnType<typeof listShape> = []
// Streamdown 的 li 会去掉单独的 p 包装，转换规则应在渲染组件处理前检查。
function observeConvertedLists() {
  return (tree: MarkdownNode) => {
    convertedShape = []
    visit(tree, (node) => {
      if (node.tagName !== "ol" && node.tagName !== "ul") return
      convertedShape.push({
        tag: node.tagName.toUpperCase(),
        start: node.properties?.start === undefined ? null : String(node.properties.start),
        paragraphs: (node.children ?? [])
          .filter((child) => child.tagName === "li")
          .map((item) => (item.children ?? []).filter((child) => child.tagName === "p").length),
      })
    })
  }
}
const rehypePlugins = [...Object.values(defaultRehypePlugins), observeConvertedLists]
let root: Root
let container: HTMLDivElement
const openFile = () => {}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  inspectTree = () => {}
  convertedShape = []
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

async function convert(source: string) {
  await act(async () =>
    root.render(
      <Streamdown
        mode="static"
        animated={false}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
      >
        {source}
      </Streamdown>
    )
  )
}
async function render(source: string, streaming = false) {
  await act(async () =>
    root.render(
      <AssistantMarkdown
        text={source}
        streaming={streaming}
        animateInitialText={false}
        onOpenFile={openFile}
      />
    )
  )
}
function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void) {
  callback(node)
  for (const child of node.children ?? []) visit(child, callback)
}
function listShape() {
  return [...container.querySelectorAll("ol, ul")].map((list) => ({
    tag: list.tagName,
    start: list.getAttribute("start"),
    paragraphs: [...list.querySelectorAll(":scope > li")].map(
      (item) => item.querySelectorAll(":scope > p").length
    ),
  }))
}

it.each([256, 1024])(
  "bounds tight-list spacing checks to linear work for %i items",
  async (count) => {
    let reads = 0
    inspectTree = (tree) =>
      visit(tree, (node) => {
        if (node.type !== "listItem") return
        const spread = node.spread
        Object.defineProperty(node, "spread", {
          configurable: true,
          enumerable: true,
          get() {
            reads++
            return spread
          },
        })
      })
    await convert(Array.from({ length: count }, (_, i) => `${i + 1}. item`).join("\n"))
    expect(container.querySelectorAll("li")).toHaveLength(count)
    expect(reads).toBeGreaterThanOrEqual(count)
    expect(reads).toBeLessThanOrEqual(count * 2)
  }
)

it("recomputes spacing when the same list object is changed between conversions", async () => {
  let list: MarkdownNode
  inspectTree = (tree) => {
    list = tree.children![0]
  }
  await convert("- first\n- second")
  expect(convertedShape[0]?.paragraphs).toEqual([0, 0])

  const second = list!.children![1]
  second.spread = true
  second.children!.push({ type: "paragraph", children: [{ type: "text", value: "additional" }] })
  inspectTree = (tree) => {
    tree.children = [list!]
  }
  const before = JSON.stringify(list!)
  await convert("second conversion")
  expect(convertedShape[0]?.paragraphs).toEqual([1, 2])
  expect(container.textContent).toContain("additional")
  expect(JSON.stringify(list!)).toBe(before)

  second.spread = false
  second.children!.pop()
  await convert("third conversion")
  expect(convertedShape[0]?.paragraphs).toEqual([0, 0])
  visit(list!, (node) => {
    if (node.children) Object.freeze(node.children)
    Object.freeze(node)
  })
  await convert("frozen input")
  expect(convertedShape[0]?.paragraphs).toEqual([0, 0])
})

it.each([null, undefined])(
  "preserves the paragraph-count fallback when item spread is %s",
  async (spread) => {
    inspectTree = (tree) => {
      const list = tree.children![0]
      list.children![0].spread = spread
      list.children![0].children!.push({
        type: "paragraph",
        children: [{ type: "text", value: "extra" }],
      })
    }
    await convert("- first\n- second")
    expect(convertedShape[0]?.paragraphs).toEqual([2, 1])
    expect(container.textContent).toContain("extra")
  }
)

it.each([
  { source: "3. first\n4. second", shape: [{ tag: "OL", start: "3", paragraphs: [0, 0] }] },
  { source: "- first\n\n- second", shape: [{ tag: "UL", start: null, paragraphs: [1, 1] }] },
  {
    source: "- first\n\n  extra\n- second",
    shape: [{ tag: "UL", start: null, paragraphs: [2, 1] }],
  },
  {
    source: "- outer\n  - inner first\n\n  - inner second\n- sibling",
    shape: [
      { tag: "UL", start: null, paragraphs: [0, 0] },
      { tag: "UL", start: null, paragraphs: [1, 1] },
    ],
  },
  {
    source: "- outer\n\n  extra\n\n  3. inner first\n  4. inner second\n- sibling",
    shape: [
      { tag: "UL", start: null, paragraphs: [2, 1] },
      { tag: "OL", start: "3", paragraphs: [0, 0] },
    ],
  },
])("preserves independent list spacing and numbering: $source", async ({ source, shape }) => {
  await convert(source)
  expect(convertedShape).toEqual(shape)
})

it("preserves nested task-list checkboxes and disabled state", async () => {
  await render("1. parent\n   - [x] done\n   - [ ] todo\n2. sibling")
  expect(listShape()).toEqual([
    { tag: "OL", start: null, paragraphs: [0, 0] },
    { tag: "UL", start: null, paragraphs: [0, 0] },
  ])
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
    [true, true],
    [false, true],
  ])
  expect(container.querySelectorAll(".task-list-item")).toHaveLength(2)
  expect(container.querySelectorAll(".contains-task-list")).toHaveLength(1)
})

it("updates task-list spacing and nested content as a stream grows and completes", async () => {
  let source = "- [x] done\n- [ ] work"
  await render(source, true)
  expect(listShape()[0]?.paragraphs).toEqual([0, 0])
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  source += " in progress"
  await render(source, true)
  expect(container.textContent).toContain("work in progress")
  expect(container.querySelectorAll("[data-sd-animate]").length).toBeLessThanOrEqual(512)
  await act(async () => vi.advanceTimersByTimeAsync(180))
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)

  source += "\n\n  additional paragraph"
  await render(source, true)
  expect(listShape()[0]?.paragraphs).toEqual([0, 2])
  source += "\n\n  - [ ] nested todo"
  await render(source, true)
  expect(listShape()).toEqual([
    { tag: "UL", start: null, paragraphs: [0, 2] },
    { tag: "UL", start: null, paragraphs: [0] },
  ])
  const shape = listShape()
  const text = container.textContent
  await render(source, false)
  expect(listShape()).toEqual(shape)
  expect(container.textContent).toBe(text)
  expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0)
  const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
    [true, true],
    [false, true],
    [false, true],
  ])
})
