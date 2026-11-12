// @vitest-environment jsdom
import { act } from "react"
import type { ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  businessDataFixture,
  businessDataSnapshot,
  resetBusinessDataFixture,
} from "@renderer/lib/__test__/business-data-fixture"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
import { imageAnnotationKey } from "@renderer/components/desktop/image-viewer/image-annotations"
import { imageSourceKey } from "@renderer/components/desktop/image-viewer/image-source"
import {
  writeUtilityPanelRuntimeState,
  writeUtilityPanelViewStates,
} from "../utility-panel-repository"
import { defaultUtilityPanelRuntimeState } from "../use-utility-panel-runtime"
vi.mock("@renderer/components/desktop/shell/plugin-apps/provider", () => ({
  usePluginApps: () => null,
  usePluginAppPages: () => [],
}))
vi.mock("@renderer/components/desktop/tools/browser/browser-tool", () => ({
  BrowserTool: () => null,
}))
vi.mock("@renderer/components/desktop/tools/files/files-tool", () => ({ FilesTool: () => null }))
vi.mock("@renderer/components/desktop/tools/terminal/terminal-tool", () => ({
  TerminalTool: () => null,
}))
vi.mock("@renderer/components/desktop/tools/agents/agents-tool", () => ({ AgentsTool: () => null }))
vi.mock("@renderer/components/desktop/tools/workflows/workflow-tool", () => ({
  WorkflowTool: () => null,
}))
vi.mock("@renderer/components/desktop/tools/review/review-tool", () => ({ ReviewTool: () => null }))
vi.mock("@renderer/components/desktop/tools/side-chat/side-chat-panel", () => ({
  SideChatPanel: () => null,
  destroySideChat: vi.fn(),
}))
// The tab strip only presents actions. Exercise its real parent handlers with the real image panel,
// image hook, annotator and recovery queue; do not replace the image guard with a mock.
vi.mock("../utility-panel-tab-strip", () => ({
  EmptyUtilityPanelState: () => null,
  UtilityPanelTabStrip: (
    props: ComponentProps<typeof import("../utility-panel-tab-strip").UtilityPanelTabStrip>
  ) => {
    const other = props.tabs.find((tab) => tab.id === "agents-tab")!
    const image = props.tabs.find((tab) => tab.tool === "image")
    return (
      <nav>
        <button onClick={() => image && props.onCloseTab(image.id)}>close image</button>
        <button onClick={() => props.onSelect(other)}>select other</button>
        <button onClick={() => props.onCloseOtherTabs(other)}>close others</button>
        <button onClick={() => props.onCloseTabsToRight(other)}>close right</button>
        <button onClick={props.onClosePanel}>close panel</button>
        <button onClick={() => props.onAdd("agents")}>add tool</button>
      </nav>
    )
  },
}))
import { ImageViewer } from "@renderer/components/desktop/image-viewer/image-viewer"
void ImageViewer // Warm the real lazy module before React starts the panel.
import { UtilityPanel } from "../utility-panel"
import { useUtilityPanelController } from "../use-utility-panel-controller"
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let sequence = 0
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:image"
      }
      static revokeObjectURL() {}
    }
  )
  resetDesktopSessionStore()
  useDesktopSessionStore.setState({
    attachmentSupport: {
      daemonSupported: true,
      interactionEnabled: true,
      limits: null,
      uploadModes: ["single"],
    },
  })
  resetBusinessDataFixture()
  Object.assign(window, { desktop: { ...window.desktop, businessData: businessDataFixture } })
  localStorage.clear()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function mount() {
  const sessionId = `image-leave-${++sequence}`
  const scopeId = `session:${sessionId}`
  const source = {
    kind: "memory" as const,
    id: "photo",
    name: "photo.png",
    bytes: new Uint8Array([7, 8, 9]).buffer,
    mediaType: "image/png",
  }
  const storageKey = await imageAnnotationKey(source.bytes)
  localStorage.setItem(
    storageKey,
    JSON.stringify([{ id: "one", x: 20, y: 10, width: 40, height: 30, comment: "A" }])
  )
  writeUtilityPanelRuntimeState(scopeId, {
    ...defaultUtilityPanelRuntimeState(),
    tabs: [
      { id: "agents-tab", tool: "agents", title: "Other" },
      { id: imageSourceKey(source), tool: "image", title: source.name, imageSource: source },
    ],
    activeTabId: imageSourceKey(source),
  })
  writeUtilityPanelViewStates({
    [scopeId]: { open: true, maximized: false, layout: { conversation: 60, utility: 40 } },
  })
  const beforeCollapseRef = { current: null as ((leave: () => void) => void) | null }
  let layout = { conversation: 60, utility: 40 }
  const pane = {
    current: {
      isCollapsed: () => layout.utility === 0,
      collapse: () => {
        layout = { conversation: 100, utility: 0 }
      },
      expand: () => {},
      resize: () => {},
      getSize: () => ({ asPercentage: layout.utility, inPixels: layout.utility * 10 }),
    },
  }
  const group = {
    current: {
      getLayout: () => layout,
      setLayout: (value: typeof layout) => {
        layout = value
        return value
      },
    },
  }
  function Panel() {
    const controller = useUtilityPanelController({
      activeSessionId: sessionId,
      selectedProjectId: null,
      sessionIds: [sessionId],
      defaultLayout: { conversation: 60, utility: 40 },
      collapsedLayout: { conversation: 100, utility: 0 },
      conversationPanelRef: pane as never,
      utilityPanelRef: pane as never,
      workspaceGroupRef: group as never,
      groupElementRef: { current: null },
      onCollapseSidebar: () => {},
      beforeCollapseRef,
    })
    return (
      <>
        <button onClick={() => controller.openTool("agents")}>external tool</button>
        <button onClick={controller.collapse}>controller collapse</button>
        <button onClick={controller.toggle}>controller toggle</button>
        <button
          onClick={() => {
            layout = { conversation: 100, utility: 0 }
            controller.handlePanelResize(0)
          }}
        >
          controller resize
        </button>
        <UtilityPanel
          scopeId={scopeId}
          open={controller.open}
          beforeCollapseRef={beforeCollapseRef}
          maximized={false}
          onToggleMaximized={() => {}}
          onClose={controller.collapse}
          fileOpenRequest={null}
          reviewOpenRequest={null}
          terminalOpenRequest={null}
          toolOpenRequest={controller.toolOpenRequest}
          onOpenFile={() => {}}
          onOpenReview={() => {}}
          onOpenTerminal={() => {}}
        />
      </>
    )
  }
  await act(async () => root.render(<Panel />))
  await vi.waitFor(async () => {
    await act(async () => {
      await delay(5)
    })
    expect(host.querySelector("img")).not.toBeNull()
  })
  const image = host.querySelector("img")!
  Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } })
  await act(async () => {
    image.dispatchEvent(new Event("load"))
    await delay(50)
  })
  await vi.waitFor(async () => {
    await act(async () => {
      await delay(5)
    })
    expect(host.querySelector<HTMLButtonElement>('[aria-label="添加批注"]')?.disabled).toBe(false)
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="批注"]')!.click())
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="定位批注 1"]')!.click()
    await delay(100)
  })
  expect(host.querySelector("textarea")).not.toBeNull()
  return {
    key: {
      kind: "image-annotations" as const,
      imageKey: storageKey.slice("vykor-image-annotations-v1:".length),
    },
    layout: () => layout,
  }
}
function edit(value: string) {
  const textarea = host.querySelector("textarea")!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value
  )
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}
async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click()
  )
  await act(async () => {
    await delay(5)
  })
}
it.each([
  "close image",
  "select other",
  "close others",
  "close right",
  "close panel",
  "add tool",
  "controller collapse",
  "controller toggle",
  "controller resize",
  "external tool",
])("%s waits for persistence, retains the editor on failure and permits retry", async (action) => {
  const { key, layout } = await mount()
  const write = businessDataFixture.write.bind(businessDataFixture)
  let reject!: (error: Error) => void
  let attempts = 0
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  vi.spyOn(businessDataFixture, "write").mockImplementation(async (...args) => {
    attempts++
    await pending
    return write(...args)
  })
  await act(async () => edit("B"))
  await vi.waitFor(() => expect(attempts).toBeGreaterThan(0))
  await click(action)
  expect(host.querySelector("textarea")?.value).toBe("B")
  if (action === "controller resize") expect(layout().utility).toBeGreaterThan(0)
  await act(async () => {
    reject(new Error("disk full"))
    await delay(5)
  })
  expect(host.querySelector("textarea")?.value).toBe("B")
  expect(host.textContent).toContain("批注草稿未能保存")
  vi.mocked(businessDataFixture.write).mockImplementation(write)
  await act(async () => edit("C"))
  await click(action)
  await vi.waitFor(() => expect(host.querySelector('[aria-label="图片查看与批注"]')).toBeNull())
  expect(businessDataSnapshot(key)[0].comment).toBe("C")
})

it.each(["close image", "close others", "controller resize"])(
  "%s persists an edit made during the departure wait",
  async (action) => {
    const { key } = await mount()
    const write = businessDataFixture.write.bind(businessDataFixture)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let attempts = 0
    vi.spyOn(businessDataFixture, "write").mockImplementation(async (...args) => {
      if (++attempts === 1) await pending
      return write(...args)
    })
    await act(async () => edit("B"))
    await click(action)
    expect(host.querySelector("textarea")?.value).toBe("B")
    await act(async () => edit("A"))
    await act(async () => {
      release()
      await delay(5)
    })
    await vi.waitFor(() => expect(host.querySelector('[aria-label="图片查看与批注"]')).toBeNull())
    expect(businessDataSnapshot(key)[0].comment).toBe("A")
  }
)
