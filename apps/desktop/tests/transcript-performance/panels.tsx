import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  usePanelRef,
  type Layout,
} from "react-resizable-panels"
import {
  VirtualTranscript,
  type TranscriptRow,
} from "../../src/renderer/src/components/desktop/conversation-page/transcript/virtual-transcript"
import {
  ConversationScrollerProvider,
  ConversationScrollerViewport,
  ConversationScrollerContent,
} from "../../src/renderer/src/components/desktop/conversation-page/conversation-scroller"
import { useConversationScroller } from "../../src/renderer/src/components/desktop/conversation-page/conversation-scroll-context"
import { useUtilityPanelController } from "../../src/renderer/src/components/desktop/layout/main-layout/utility-panel/use-utility-panel-controller"
import { writeUtilityPanelViewStates } from "../../src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel-repository"
import { beginPanelToggleTransition } from "../../src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition"

// 与生产分栏相同的 200ms flex-grow 过渡；其余 CSS 仅提供可测量的固定视口。
const style = document.createElement("style")
style.textContent = `body{font:14px sans-serif} [data-group]{height:500px}[data-separator]{width:4px}[data-panel-animating]>[data-panel]{transition:flex-grow 200ms ease-out}[data-slot=message-scroller-viewport]{height:480px;overflow-y:auto;overflow-anchor:none}[data-slot=message-scroller-content]{min-height:100%}[data-virtual-transcript]{position:relative;width:100%}[data-transcript-row]{position:absolute;top:0;left:0;width:100%}`
document.head.append(style)
const root = createRoot(document.getElementById("root")!)
const defaultLayout = { conversation: 60, utility: 40 }
const collapsedLayout = { conversation: 100, utility: 0 }
const sessionIds = ["panel-perf"]
const metrics = { shellCommits: 0, layoutReports: 0, storageWrites: 0, sidebarResizes: 0 }
const setItem = Storage.prototype.setItem
Storage.prototype.setItem = function (key, value) {
  if (key === "vykor.desktop.utility-panel-states") metrics.storageWrites++
  setItem.call(this, key, value)
}
let rows: TranscriptRow[] = []
let tailSize = 0
const tailListeners = new Set<() => void>()
const subscribeTail = (listener: () => void) => {
  tailListeners.add(listener)
  return () => {
    tailListeners.delete(listener)
  }
}
const readTail = () => tailSize
const grow = () =>
  flushSync(() => {
    tailSize++
    tailListeners.forEach((listener) => listener())
  })
let scroller: NonNullable<ReturnType<typeof useConversationScroller>>
let utility: ReturnType<typeof useUtilityPanelController>
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  for (let index = 0; index < 8; index++) await frame()
}
function check(value: boolean, message: string) {
  if (!value) throw new Error(message)
}
export function StreamingReply() {
  const size = useSyncExternalStore(subscribeTail, readTail)
  return <div data-stream-size={size}>{"持续增长的回复内容 ".repeat(100 + size * 4)}</div>
}
export function ScrollProbe() {
  const state = useConversationScroller()!
  useLayoutEffect(() => {
    scroller = state
  }, [state])
  return null
}
export function PanelScenario() {
  const outerElement = useRef<HTMLDivElement>(null)
  const innerElement = useRef<HTMLDivElement>(null)
  const sidebarPanelRef = usePanelRef()
  const conversation = usePanelRef()
  const right = usePanelRef()
  const group = useGroupRef()
  const cancel = useRef<(() => void) | null>(null)
  const toggleSidebar = useCallback(() => {
    cancel.current?.()
    cancel.current = beginPanelToggleTransition(outerElement.current)
    const panel = sidebarPanelRef.current
    if (panel?.isCollapsed()) panel.expand()
    else panel?.collapse()
  }, [sidebarPanelRef])
  const controller = useUtilityPanelController({
    activeSessionId: "panel-perf",
    selectedProjectId: null,
    sessionIds,
    defaultLayout,
    collapsedLayout,
    conversationPanelRef: conversation,
    utilityPanelRef: right,
    workspaceGroupRef: group,
    groupElementRef: innerElement,
    onCollapseSidebar: toggleSidebar,
  })
  const handleLayoutChanged = controller.handleLayoutChanged
  const layoutChanged = useCallback(
    (layout: Layout) => {
      metrics.layoutReports++
      handleLayoutChanged(layout)
    },
    [handleLayoutChanged]
  )
  useLayoutEffect(() => {
    utility = controller
  }, [controller])
  useLayoutEffect(() => {
    metrics.shellCommits++
  })
  useLayoutEffect(() => () => cancel.current?.(), [])
  return (
    <>
      <button id="sidebar-toggle" onClick={toggleSidebar}>
        侧栏
      </button>
      <button id="utility-toggle" onClick={controller.toggle}>
        工具面板
      </button>
      <button id="utility-maximize" onClick={controller.toggleMaximized}>
        最大化
      </button>
      <Group id="panel-shell" elementRef={outerElement} orientation="horizontal">
        <Panel
          id="sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={260}
          minSize={180}
          maxSize={400}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          onResize={() => {
            metrics.sidebarResizes++
          }}
        >
          <div style={{ width: 260 }}>
            {Array.from({ length: 100 }, (_, i) => (
              <div key={i}>会话 {i}</div>
            ))}
          </div>
        </Panel>
        <Separator aria-label="调整侧边栏宽度" />
        <Panel id="workspace" minSize={670}>
          <Group
            id="panel-workspace"
            elementRef={innerElement}
            groupRef={group}
            orientation="horizontal"
            defaultLayout={
              controller.maximized
                ? { conversation: 0, utility: 100 }
                : controller.open
                  ? controller.visibleLayout
                  : collapsedLayout
            }
            onLayoutChanged={layoutChanged}
          >
            <Panel
              id="conversation"
              panelRef={conversation}
              minSize={controller.maximized ? 0 : 350}
              collapsible
              collapsedSize={0}
            >
              <ConversationScrollerProvider>
                <ScrollProbe />
                <ConversationScrollerViewport>
                  <ConversationScrollerContent>
                    <VirtualTranscript
                      rows={rows}
                      renderRow={(index) =>
                        index === rows.length - 1 ? (
                          <StreamingReply />
                        ) : (
                          <div>{"历史正文随宽度换行 ".repeat(80)}</div>
                        )
                      }
                    />
                  </ConversationScrollerContent>
                </ConversationScrollerViewport>
              </ConversationScrollerProvider>
            </Panel>
            {!controller.maximized && <Separator aria-label="调整工具面板宽度" />}
            <Panel
              id="utility"
              panelRef={right}
              defaultSize="40%"
              minSize={320}
              maxSize={controller.maximized ? "100%" : "70%"}
              collapsible
              collapsedSize={0}
              disabled={!controller.open}
              groupResizeBehavior="preserve-pixel-size"
              onResize={(size) => controller.handlePanelResize(size.inPixels)}
            >
              <div>
                {Array.from({ length: 100 }, (_, i) => (
                  <div key={i}>工具条目 {i}</div>
                ))}
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>
    </>
  )
}
const viewport = () =>
  document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
const api = {
  async prepare(count: number) {
    flushSync(() => root.render(null))
    tailSize = 0
    writeUtilityPanelViewStates({
      "session:panel-perf": { open: true, maximized: false, layout: defaultLayout },
    })
    rows = Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      messageIds: [`prompt-${index}`],
      estimateSize: 240,
    }))
    flushSync(() => root.render(<PanelScenario />))
    await settle()
  },
  reset() {
    Object.assign(metrics, {
      shellCommits: 0,
      layoutReports: 0,
      storageWrites: 0,
      sidebarResizes: 0,
    })
  },
  async toggle(target: "sidebar" | "utility") {
    api.reset()
    const width = document.getElementById("utility")!.getBoundingClientRect().width
    for (let repeat = 0; repeat < 2; repeat++) {
      document.getElementById(`${target}-toggle`)!.click()
      for (let index = 0; index < 20; index++) {
        grow()
        await frame()
      }
      await settle()
    }
    check(scroller.getSnapshot().following, "toggle lost following")
    check(
      Math.abs(viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop) <= 1,
      "toggle lost bottom"
    )
    check(utility.open, "utility failed to reopen")
    const restored = document.getElementById("utility")!.getBoundingClientRect().width
    check(Math.abs(restored - width) < 3, `utility width changed ${width} -> ${restored}`)
    if (target === "sidebar") {
      check(metrics.layoutReports > 4, "fixture did not exercise intermediate animation layouts")
      check(
        metrics.shellCommits <= 4 && metrics.storageWrites <= 4,
        "animation published intermediate layout state"
      )
    }
    return { ...metrics, maxMounted: document.querySelectorAll("[data-transcript-row]").length }
  },
  separatorInfo(target: "sidebar" | "utility") {
    const label = target === "sidebar" ? "调整侧边栏宽度" : "调整工具面板宽度"
    const separator = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
    separator.focus()
    const rect = separator.getBoundingClientRect()
    const width = document.getElementById(target)!.getBoundingClientRect().width
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width }
  },
  async growFrame() {
    grow()
    await frame()
  },
  async resized(target: "sidebar" | "utility", before: number) {
    await settle()
    const width = document.getElementById(target)!.getBoundingClientRect().width
    check(Math.abs(width - before) > 1, `${target} resize had no effect`)
    check(scroller.getSnapshot().following, "resize lost following")
    check(
      Math.abs(viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop) <= 1,
      "resize lost bottom"
    )
    return { passed: true }
  },
  async regress() {
    check(scroller.scrollToMessage("prompt-400"), "navigation unavailable")
    await settle()
    const position = viewport().scrollTop
    const beforeGrowth = tailSize
    document.getElementById("sidebar-toggle")!.click()
    for (let index = 0; index < 20; index++) {
      grow()
      await frame()
    }
    await settle()
    check(!scroller.getSnapshot().following, "panel toggle rearmed follow")
    check(
      document.querySelector('[data-transcript-row="turn-400"]') !== null,
      "panel toggle lost historical row"
    )
    // 宽度变化会重排正文，允许阅读点上方的测高补偿，但不能跳回末轮。
    check(
      viewport().scrollTop < viewport().scrollHeight / 2 && position > 0,
      "panel toggle moved reader to end"
    )
    document.getElementById("sidebar-toggle")!.click()
    await settle()
    scroller.scrollToEnd()
    await settle()
    check(
      tailSize > beforeGrowth &&
        document.querySelector(`[data-stream-size="${tailSize}"]`) !== null,
      "offscreen stream did not advance"
    )
    document.getElementById("utility-maximize")!.click()
    await settle()
    await settle()
    check(utility.maximized, "maximize failed")
    document.getElementById("utility-maximize")!.click()
    await settle()
    await settle()
    check(!utility.maximized && utility.open, "restore maximized failed")
    check(scroller.getSnapshot().following, "restore lost following")
    document.getElementById("sidebar-toggle")!.click()
    await frame()
    document.getElementById("sidebar-toggle")!.click()
    await settle()
    await settle()
    check(
      document.getElementById("sidebar")!.getBoundingClientRect().width > 180,
      "rapid toggle failed to reopen"
    )
    check(!document.querySelector("[data-panel-animating]"), "rapid toggle left stale animation")
    return { passed: true }
  },
}
Object.assign(window, { panelPerformance: api })
