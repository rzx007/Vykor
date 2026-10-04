// @vitest-environment jsdom
import { act, type RefObject } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { GroupImperativeHandle, Layout, PanelImperativeHandle } from "react-resizable-panels"
import {
  useUtilityPanelController,
  type UtilityPanelController,
} from "./use-utility-panel-controller"
import { writeUtilityPanelViewStates } from "./utility-panel-repository"

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
})

function mount(maximized: boolean, initialLayout: Layout) {
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
  const element = { current: null }
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
  return { toggle: () => act(() => controller.toggleMaximized()), layout: () => layout, controller: () => controller }
}

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
