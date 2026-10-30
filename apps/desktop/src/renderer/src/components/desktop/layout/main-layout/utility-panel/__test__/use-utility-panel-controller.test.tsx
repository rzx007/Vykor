// @vitest-environment jsdom
import { act, type RefObject } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { GroupImperativeHandle, Layout, PanelImperativeHandle } from "react-resizable-panels"
import {
  useUtilityPanelController,
  type UtilityPanelController,
} from "../use-utility-panel-controller"
import {
  readUtilityPanelViewStates,
  writeUtilityPanelViewStates,
} from "../utility-panel-repository"

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  localStorage.removeItem("vykor.desktop.utility-panel-states")
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  localStorage.removeItem("vykor.desktop.utility-panel-states")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(
  maximized: boolean,
  initialLayout: Layout,
  groupElement: HTMLDivElement | null = null
) {
  writeUtilityPanelViewStates({
    "session:chat": { open: true, maximized, layout: { conversation: 60, utility: 40 } },
  })
  let layout = initialLayout
  let controller!: UtilityPanelController
  // 分栏库的命令边界：测试真实 controller 向它恢复的比例，浏览器验证实际像素布局。
  const group: RefObject<GroupImperativeHandle> = {
    current: {
      getLayout: () => layout,
      setLayout: (next) => {
        layout = next
        return layout
      },
    },
  }
  function panel(id: string): RefObject<PanelImperativeHandle> {
    return {
      current: {
        collapse: () => {},
        expand: () => {
          // 原生分栏先按最小宽度展开，会同步回报一个中间比例。
          if (id === "conversation" && layout.conversation === 0) {
            layout = { conversation: 35, utility: 65 }
            controller.handleLayoutChanged(layout)
          }
        },
        getSize: () => ({ asPercentage: layout[id]!, inPixels: layout[id]! * 10 }),
        isCollapsed: () => layout[id] === 0,
        resize: () => {},
      },
    }
  }
  const conversation = panel("conversation")
  const utility = panel("utility")
  const element = { current: groupElement }
  const options = {
    activeSessionId: "chat",
    selectedProjectId: null,
    sessionIds: ["chat"],
    defaultLayout: { conversation: 50, utility: 50 },
    collapsedLayout: { conversation: 100, utility: 0 },
    conversationPanelRef: conversation,
    utilityPanelRef: utility,
    workspaceGroupRef: group,
    groupElementRef: element,
    onCollapseSidebar: () => {},
  }
  function Workspace() {
    controller = useUtilityPanelController(options)
    return null
  }
  act(() => root.render(<Workspace />))
  return {
    toggle: () => act(() => controller.toggleMaximized()),
    layout: () => layout,
    controller: () => controller,
    switchSession: (id: string) =>
      act(() => {
        options.activeSessionId = id
        root.render(<Workspace />)
      }),
  }
}

it("opens image requests in the originating scope and keeps successive requests unique", () => {
  const workspace = mount(false, { conversation: 100, utility: 0 })
  const source = { kind: "attachment" as const, assetId: "image-one", name: "image.png" }
  act(() => workspace.controller().openImage(source))
  const first = workspace.controller().imageOpenRequest!
  expect(workspace.controller().open).toBe(true)
  expect(first.source).toEqual(source)
  act(() => workspace.controller().openImage(source))
  expect(workspace.controller().imageOpenRequest!.id).toBeGreaterThan(first.id)
  workspace.switchSession("other-chat")
  expect(workspace.controller().imageOpenRequest).toBeNull()
  workspace.switchSession("chat")
  expect(workspace.controller().imageOpenRequest!.source).toEqual(source)
})

it("forwards a caller's gallery and rejects opens captured in a previous panel scope", () => {
  const workspace = mount(false, { conversation: 100, utility: 0 })
  const source = { kind: "attachment" as const, assetId: "image-one", name: "one.png" }
  const gallery = { id: "conversation:chat", sources: [source], composerScope: "session:chat" }
  const openImage = workspace.controller().openImage
  act(() => openImage(source, gallery, "session:chat"))
  expect(workspace.controller().imageOpenRequest?.gallery).toBe(gallery)
  workspace.switchSession("other-chat")
  act(() => openImage(source, gallery, "session:chat"))
  expect(workspace.controller().imageOpenRequest).toBeNull()
})

it("restores the saved split after reopening an already maximized workbench", () => {
  const workspace = mount(true, { conversation: 0, utility: 100 })
  workspace.toggle()
  expect(workspace.layout()).toEqual({ conversation: 60, utility: 40 })
})

it("keeps the live pre-maximize split instead of replacing it with the saved fallback", () => {
  const workspace = mount(false, { conversation: 55, utility: 45 })
  workspace.toggle()
  expect(workspace.layout()).toEqual({ conversation: 0, utility: 100 })
  workspace.toggle()
  expect(workspace.layout()).toEqual({ conversation: 55, utility: 45 })
})

it("restores an earlier resize split while the panel is already open", () => {
  const workspace = mount(false, { conversation: 35, utility: 65 })
  act(() => workspace.controller().restore({ conversation: 60, utility: 40 }))
  expect(workspace.layout()).toEqual({ conversation: 60, utility: 40 })
  expect(workspace.controller().open).toBe(true)
})

it("uses the saved open split when reset has no earlier expanded resize", () => {
  const workspace = mount(false, { conversation: 35, utility: 65 })
  act(() => workspace.controller().restore(null))
  expect(workspace.layout()).toEqual({ conversation: 60, utility: 40 })
})

it("repeated side chat requests activate a new request even within the same clock tick", () => {
  const workspace = mount(false, { conversation: 55, utility: 45 })
  vi.spyOn(Date, "now").mockReturnValue(100)
  act(() => workspace.controller().openTool("side-chat"))
  const first = workspace.controller().toolOpenRequest!
  act(() => workspace.controller().openTool("side-chat"))
  expect(workspace.controller().toolOpenRequest?.tool).toBe("side-chat")
  expect(workspace.controller().toolOpenRequest?.id).toBeGreaterThan(first.id)
  vi.restoreAllMocks()
})

it("does not reuse a tool request ID when the same scope controller is remounted", () => {
  const first = mount(false, { conversation: 55, utility: 45 })
  act(() => first.controller().openTool("side-chat"))
  const firstId = first.controller().toolOpenRequest!.id
  act(() => root.render(null))
  const reopened = mount(false, { conversation: 55, utility: 45 })
  act(() => reopened.controller().openTool("side-chat"))
  expect(reopened.controller().toolOpenRequest!.id).toBeGreaterThan(firstId)
})

it("does not reverse an explicit open or close when animation reports an intermediate width", () => {
  const element = document.createElement("div")
  const workspace = mount(false, { conversation: 100, utility: 0 }, element)
  act(() => workspace.controller().restore())
  expect(workspace.controller().open).toBe(true)
  act(() => workspace.controller().handlePanelResize(0))
  expect(workspace.controller().open).toBe(true)

  act(() => workspace.controller().collapse())
  act(() => workspace.controller().handlePanelResize(180))
  expect(workspace.controller().open).toBe(false)

  // A real drag after the animation must still update the open state.
  element.removeAttribute("data-panel-animating")
  act(() => workspace.controller().handlePanelResize(180))
  expect(workspace.controller().open).toBe(true)
  act(() => workspace.controller().handlePanelResize(0))
  expect(workspace.controller().open).toBe(false)
})

it("commits only the final split after an ancestor panel finishes animating", () => {
  const outer = document.createElement("div")
  const element = outer.appendChild(document.createElement("div"))
  const workspace = mount(false, { conversation: 60, utility: 40 }, element)
  const writes = vi.spyOn(Storage.prototype, "setItem")
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id)
  })
  outer.setAttribute("data-panel-animating", "true")
  for (let index = 1; index <= 20; index++) {
    act(() =>
      workspace
        .controller()
        .handleLayoutChanged({ conversation: 60 - index / 4, utility: 40 + index / 4 })
    )
  }
  console.info(
    JSON.stringify({
      scenario: "ancestor-toggle-layout",
      reports: 20,
      writes: writes.mock.calls.length,
    })
  )
  expect(writes).not.toHaveBeenCalled()
  expect(workspace.controller().visibleLayout).toEqual({ conversation: 60, utility: 40 })
  // 动画仍在进行时，下一帧也不能发布中间比例。
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    queued.forEach((callback) => callback(0))
  })
  expect(writes).not.toHaveBeenCalled()
  outer.removeAttribute("data-panel-animating")
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    queued.forEach((callback) => callback(0))
  })
  expect(workspace.controller().visibleLayout).toEqual({ conversation: 55, utility: 45 })
  expect(readUtilityPanelViewStates()["session:chat"]?.layout).toEqual({
    conversation: 55,
    utility: 45,
  })
  expect(writes).toHaveBeenCalledTimes(1)
  writes.mockRestore()
})

it("does not let a deferred split overwrite a later session or a manual resize", () => {
  const outer = document.createElement("div")
  const element = outer.appendChild(document.createElement("div"))
  const workspace = mount(false, { conversation: 60, utility: 40 }, element)
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id)
  })
  const flush = () =>
    act(() => {
      const queued = [...frames.values()]
      frames.clear()
      queued.forEach((callback) => callback(0))
    })
  outer.setAttribute("data-panel-animating", "true")
  act(() => workspace.controller().handleLayoutChanged({ conversation: 55, utility: 45 }))
  outer.removeAttribute("data-panel-animating")
  act(() => workspace.controller().handleLayoutChanged({ conversation: 62, utility: 38 }))
  flush()
  expect(workspace.controller().visibleLayout).toEqual({ conversation: 62, utility: 38 })
  outer.setAttribute("data-panel-animating", "true")
  act(() => workspace.controller().handleLayoutChanged({ conversation: 56, utility: 44 }))
  workspace.switchSession("other")
  outer.removeAttribute("data-panel-animating")
  flush()
  expect(workspace.controller().visibleLayout).toEqual({ conversation: 50, utility: 50 })
  expect(readUtilityPanelViewStates()["session:other"]?.layout).not.toEqual({
    conversation: 56,
    utility: 44,
  })
  expect(readUtilityPanelViewStates()["session:chat"]?.layout).toEqual({
    conversation: 62,
    utility: 38,
  })
})
