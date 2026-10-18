// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"

let root: Root, host: HTMLDivElement
let observers: { notify(): void; targets: Set<Element> }[]
beforeEach(() => {
  observers = []
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>()
      constructor(callback: () => void) {
        observers.push({ notify: callback, targets: this.targets })
      }
      observe = (target: Element) => this.targets.add(target)
      disconnect = () => this.targets.clear()
    }
  )
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Draft() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>草稿修改 {count}</button>
}
function Categories() {
  const [value, setValue] = useState("plugins")
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList aria-label="扩展管理">
        <TabsTrigger value="plugins">插件</TabsTrigger>
        <TabsTrigger value="skills">技能</TabsTrigger>
        <TabsTrigger value="mcp">MCP</TabsTrigger>
      </TabsList>
      <TabsContent value="plugins" keepMounted>
        <Draft />
      </TabsContent>
      <TabsContent value="skills" keepMounted>
        技能列表
      </TabsContent>
      <TabsContent value="mcp" keepMounted>
        MCP 列表
      </TabsContent>
    </Tabs>
  )
}
const tab = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) =>
    el.textContent?.startsWith(label)
  )!
async function mount() {
  await act(async () => root.render(<Categories />))
}
async function click(label: string) {
  await act(async () => tab(label).click())
}

it("links the selected category to its labelled panel", async () => {
  await mount()
  expect(host.querySelector('[role="tablist"][aria-label="扩展管理"]')).not.toBeNull()
  await click("技能")
  const selected = tab("技能")
  expect(selected.getAttribute("aria-selected")).toBe("true")
  const panel = document.getElementById(selected.getAttribute("aria-controls")!)!
  expect(panel).not.toBeNull()
  expect(panel.getAttribute("role")).toBe("tabpanel")
  expect(panel.getAttribute("aria-labelledby")).toBe(selected.id)
  expect(panel.hidden).toBe(false)
  expect(panel.textContent).toBe("技能列表")
})

it("keeps category-local input state when switching away and back", async () => {
  await mount()
  const draft = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === "草稿修改 0"
  )!
  await act(async () => draft.click())
  await click("技能")
  await click("插件")
  expect(host.textContent).toContain("草稿修改 1")
})

it("removes inactive panels from layout immediately while exit animations are still pending", async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations")
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished: new Promise(() => {}) }],
  })
  try {
    await mount()
    const previous = document.getElementById(tab("插件").getAttribute("aria-controls")!)!
    await click("技能")
    expect(previous.hidden).toBe(true)
    expect(previous.style.display).toBe("none")
    expect(
      [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((panel) => !panel.hidden)
    ).toHaveLength(1)
    await click("MCP")
    expect(
      [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((panel) => !panel.hidden)
    ).toHaveLength(1)
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "getAnimations", original)
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations")
  }
})

it("moves keyboard focus without selecting a category until it is activated", async () => {
  await mount()
  await act(async () => tab("插件").focus())
  await act(async () =>
    tab("插件").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
    )
  )
  expect(document.activeElement).toBe(tab("技能"))
  expect(tab("插件").getAttribute("aria-selected")).toBe("true")
})

it("supports selected-only icons while retaining labelled panels and keyboard activation", async () => {
  await act(async () =>
    root.render(
      <Tabs defaultValue="overview" icons="selected">
        <TabsList aria-label="编排视图">
          <TabsTrigger value="overview" aria-label="概览" icon={<svg data-icon="overview" />}>
            概览
          </TabsTrigger>
          <TabsTrigger value="graph" aria-label="任务图" icon={<svg data-icon="graph" />}>
            任务图
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">概览内容</TabsContent>
        <TabsContent value="graph">图内容</TabsContent>
      </Tabs>
    )
  )
  const graph = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="任务图"]')!
  expect(graph.querySelector("[data-tabs-icon]")).not.toBeNull()
  expect((graph.querySelector("[data-tabs-icon]") as HTMLElement).style.width).toBe("0px")
  await act(async () => graph.focus())
  expect(host.querySelector('[role="tab"][aria-label="概览"]')?.getAttribute("aria-selected")).toBe(
    "true"
  )
  await act(async () => graph.click())
  expect(graph.getAttribute("aria-selected")).toBe("true")
  expect(document.getElementById(graph.getAttribute("aria-controls")!)?.textContent).toBe("图内容")
})

it("resynchronizes the selected label after the list changes size following a settled animation", async () => {
  let pillWidth = 80
  const rect = (width: number) => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 32,
    width,
    height: 32,
    toJSON: () => ({}),
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    return rect(this.hasAttribute("data-tabs-indicator") ? pillWidth : 100)
  })
  await act(async () =>
    root.render(
      <Tabs defaultValue="overview" icons="selected">
        <TabsList aria-label="编排视图">
          <TabsTrigger value="overview" icon={<svg />}>
            概览
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">概览内容</TabsContent>
      </Tabs>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  const label = host.querySelector<HTMLElement>("[data-tabs-label]")!
  expect(label.style.clipPath).toBe("inset(0 20px 0 0px)")
  const list = host.querySelector('[role="tablist"]')!
  pillWidth = 60
  await act(async () => {
    for (const observer of observers) if (observer.targets.has(list)) observer.notify()
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  expect(label.style.clipPath).toBe("inset(0 40px 0 0px)")
})
