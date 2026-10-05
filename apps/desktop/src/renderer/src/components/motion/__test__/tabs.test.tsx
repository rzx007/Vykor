// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      disconnect = vi.fn()
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
