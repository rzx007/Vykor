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

it("hides apps and workflows only on the start page while keeping the other tool actions", async () => {
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

it("keeps apps and workflows available from the new tool tab menu", async () => {
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

  for (const [label, tool] of [
    ["应用", "plugin-app"],
    ["编排", "workflows"],
  ]) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="新建工具标签"]')!.click()
    )
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
    expect(onAdd).toHaveBeenLastCalledWith(tool)
  }
})
