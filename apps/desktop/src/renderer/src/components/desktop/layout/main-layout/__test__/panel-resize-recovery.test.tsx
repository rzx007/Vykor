// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  Group,
  Panel,
  useGroupRef,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels"

import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* Sizes are supplied by the geometry below. */
      }
      unobserve() {
        /* The fixed geometry has no subscriptions. */
      }
      disconnect() {
        /* The fixed geometry has no subscriptions. */
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute("data-panel") ? Number(this.style.flexGrow || 50) * 10 : 1000
  })
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.id === "utility") return 601
    return this.hasAttribute("data-separator") ? 600 : 0
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const first = this.parentElement?.querySelector<HTMLElement>("[data-panel]")
    const split = Number(first?.style.flexGrow || 60) * 10
    if (this.hasAttribute("data-separator")) return new DOMRect(split, 0, 1, 600)
    if (this.id === "utility") return new DOMRect(split + 1, 0, 1000 - split, 600)
    return new DOMRect(0, 0, this.hasAttribute("data-panel") ? split : 1000, 600)
  })
  container = document.body.appendChild(document.createElement("div"))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount() {
  let group!: GroupImperativeHandle
  let saved: Layout = { conversation: 60, utility: 40 }
  function Workspace() {
    const groupRef = useGroupRef()
    return (
      <Group
        groupRef={(handle) => {
          groupRef.current = handle
          if (handle) group = handle
        }}
        defaultLayout={saved}
        resizeTargetMinimumSize={{ fine: 12, coarse: 28 }}
        onLayoutChanged={(layout) => {
          saved = layout
        }}
      >
        <Panel id="conversation" defaultSize="100%" minSize="20%" collapsible />
        <PanelResizeHandle
          label="调整工具面板宽度"
          groupRef={groupRef}
          onReset={(previousLayout) => group.setLayout(previousLayout ?? saved)}
        />
        <Panel id="utility" minSize="20%" collapsible />
      </Group>
    )
  }
  act(() => root.render(<Workspace />))
  const separator = container.querySelector<HTMLDivElement>('[role="separator"]')!
  const pointer = (type: string, x: number, target: EventTarget = separator) =>
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: 100,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        })
      )
    })
  return { group: () => group, saved: () => saved, separator, pointer }
}

it("Escape restores the drag-start split, keeps persistence there and ends the library drag", () => {
  const workspace = mount()
  workspace.pointer("pointerdown", 600)
  workspace.pointer("pointermove", 750, document)
  expect(workspace.group().getLayout()).toEqual({ conversation: 75, utility: 25 })
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    )
  )
  expect(workspace.group().getLayout()).toEqual({ conversation: 60, utility: 40 })
  expect(workspace.saved()).toEqual({ conversation: 60, utility: 40 })
  workspace.pointer("pointermove", 800, document)
  expect(workspace.group().getLayout()).toEqual({ conversation: 60, utility: 40 })
})

it("double-click restores the prior split after a drag without replacing it during the two clicks", () => {
  const workspace = mount()
  workspace.pointer("pointerdown", 600)
  workspace.pointer("pointermove", 750, document)
  workspace.pointer("pointerup", 750, document)
  expect(workspace.saved()).toEqual({ conversation: 75, utility: 25 })
  for (let click = 0; click < 2; click++) {
    workspace.pointer("pointerdown", 750)
    workspace.pointer("pointerup", 750)
  }
  workspace.pointer("dblclick", 750)
  expect(workspace.group().getLayout()).toEqual({ conversation: 60, utility: 40 })
})

it("resets from the library's wider hit target beside the one-pixel separator", () => {
  const workspace = mount()
  workspace.pointer("pointerdown", 600)
  workspace.pointer("pointermove", 750, document)
  workspace.pointer("pointerup", 750, document)
  const adjacentPanel = container.querySelector("#conversation")!
  for (let click = 0; click < 2; click++) {
    workspace.pointer("pointerdown", 745, adjacentPanel)
    workspace.pointer("pointerup", 745, adjacentPanel)
  }
  workspace.pointer("dblclick", 745, adjacentPanel)
  expect(workspace.group().getLayout()).toEqual({ conversation: 60, utility: 40 })
})

it("keeps native keyboard resizing without explanatory popups", async () => {
  const workspace = mount()
  await act(async () => {
    workspace.separator.focus()
    workspace.separator.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })
    )
  })
  expect(workspace.group().getLayout()).toEqual({ conversation: 55, utility: 45 })
  expect(workspace.separator.getAttribute("aria-label")).toBe("调整工具面板宽度")
  expect(workspace.separator.hasAttribute("aria-description")).toBe(false)
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
})

it("does not cancel another prevented click just because the separator remains focused", () => {
  const workspace = mount()
  const other = container.appendChild(document.createElement("button"))
  other.addEventListener("pointerdown", (event) => event.preventDefault())
  act(() => workspace.separator.focus())
  workspace.pointer("pointerdown", 200, other)
  act(() =>
    workspace.separator.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })
    )
  )
  let escaped = false
  act(() => {
    escaped = document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    )
  })
  expect(escaped).toBe(true)
  expect(workspace.group().getLayout()).toEqual({ conversation: 55, utility: 45 })
})
