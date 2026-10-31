// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { EmptyUtilityPanelState, UtilityPanelTabStrip } from "../utility-panel-tab-strip"
import { utilityToolOrder, type UtilityTab } from "../utility-panel-tabs"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it("hides apps and workflows on the start page while keeping the other tool actions", async () => {
  const onAdd = vi.fn()
  await act(async () => {
    root.render(<EmptyUtilityPanelState availableTools={utilityToolOrder} onAdd={onAdd} />)
  })

  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
  expect(
    buttons.map((button) => button.querySelector('[data-slot="item-title"]')?.textContent)
  ).toEqual(["子智能体", "审阅", "终端", "浏览器", "文件", "侧边聊天"])

  for (const button of buttons) {
    await act(async () => button.click())
  }
  expect(onAdd.mock.calls).toEqual([
    ["agents"],
    ["review"],
    ["terminal"],
    ["browser"],
    ["files"],
    ["side-chat"],
  ])
})

it("shows the same tools in the new tab menu as on the start page", async () => {
  const onAdd = vi.fn()
  const tab: UtilityTab = { id: "browser-1", tool: "browser", title: "浏览器" }
  await act(async () => {
    root.render(
      <UtilityPanelTabStrip
        scopeId="session:start-page-menu"
        tabs={[tab]}
        activeTab={tab}
        browserTabs={[]}
        availableTools={utilityToolOrder}
        maximized={false}
        onAdd={onAdd}
        onSelect={() => {}}
        onCloseTab={() => {}}
        onCloseOtherTabs={() => {}}
        onCloseTabsToRight={() => {}}
        onToggleMaximized={() => {}}
        onClosePanel={() => {}}
      />
    )
  })

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="新建工具标签"]')!.click()
  )
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => !container.contains(button)
  )
  expect(buttons.map((button) => button.querySelector("span")?.textContent)).toEqual([
    "子智能体",
    "审阅",
    "终端",
    "浏览器",
    "文件",
    "侧边聊天",
  ])
  const terminal = buttons.find((button) => button.querySelector("span")?.textContent === "终端")!
  await act(async () => terminal.click())
  expect(onAdd).toHaveBeenCalledExactlyOnceWith("terminal")
})
