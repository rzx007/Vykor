// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible"
import { TurnProcess } from "../../desktop/conversation-page/transcript/turn-process"
import type { TurnBlockPlanItem } from "../../desktop/conversation-page/transcript/turn-block-plan"

const motionPreference = vi.hoisted(() => ({ reduce: true }))
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPreference.reduce,
}))

async function paint(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe("beUI collapsible", () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    motionPreference.reduce = true
    vi.spyOn(window, "scrollTo").mockImplementation(() => {})
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("mounts only while open and immediately releases content with reduced motion", () => {
    const mount = vi.fn(),
      cleanup = vi.fn()
    function Content() {
      useEffect(() => {
        mount()
        return cleanup
      }, [])
      return <p>process</p>
    }
    act(() =>
      root.render(
        <Collapsible>
          <CollapsibleTrigger>Toggle</CollapsibleTrigger>
          <CollapsibleContent>
            <Content />
          </CollapsibleContent>
        </Collapsible>
      )
    )
    const button = container.querySelector("button")!
    expect(mount).not.toHaveBeenCalled()
    act(() => button.click())
    expect(mount).toHaveBeenCalledTimes(1)
    const region = container.querySelector('[role="region"]')!
    expect(button.getAttribute("aria-controls")).toBe(region.id)
    expect(region.getAttribute("aria-labelledby")).toBe(button.id)
    act(() => button.click())
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="region"]')).toBeNull()
    expect(container.textContent).not.toContain("process")
    act(() => button.click())
    expect(mount).toHaveBeenCalledTimes(2)
  })

  it("keeps closing content inert until its exit animation finishes, then unmounts it", async () => {
    motionPreference.reduce = false
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240)
    const cleanup = vi.fn()
    function Content() {
      useEffect(() => cleanup, [])
      return <input aria-label="Animated content" />
    }
    act(() =>
      root.render(
        <StrictMode>
          <Collapsible>
            <CollapsibleTrigger>Toggle</CollapsibleTrigger>
            <CollapsibleContent>
              <Content />
            </CollapsibleContent>
          </Collapsible>
        </StrictMode>
      )
    )
    const trigger = container.querySelector("button")!
    act(() => trigger.click())
    await paint()
    expect((container.querySelector('[role="region"]') as HTMLElement).style.height).toBe("0px")
    await paint()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const openingHeight = parseFloat(
      (container.querySelector('[role="region"]') as HTMLElement).style.height
    )
    expect(openingHeight).toBeGreaterThan(0)
    expect(openingHeight).toBeLessThan(240)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260))
    })
    expect((container.querySelector('[role="region"]') as HTMLElement).style.height).toBe("240px")
    expect(window.scrollTo).not.toHaveBeenCalled()
    cleanup.mockClear() // StrictMode 挂载检查会先执行一次清理。
    const focus = vi.spyOn(trigger, "focus")
    act(() => container.querySelector("input")!.focus())
    act(() => trigger.click())
    const closing = container.querySelector('[role="region"]')
    expect(closing).not.toBeNull()
    expect(closing!.getAttribute("aria-hidden")).toBe("true")
    expect(closing!.hasAttribute("inert")).toBe(true)
    expect(document.activeElement).toBe(trigger)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(cleanup).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(container.querySelector('[role="region"]')).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it("animates the first visible frames of a process even after expensive content mounts", async () => {
    motionPreference.reduce = false
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(16000)
    function SlowProcess() {
      useEffect(() => {
        // 模拟长过程的 Markdown、工具组件在首帧前同步准备内容。
        const deadline = performance.now() + 200
        while (performance.now() < deadline) {
          /* block the first paint */
        }
      }, [])
      return <p>Long process</p>
    }
    const plan: TurnBlockPlanItem[] = [
      {
        key: "m",
        messageId: "m",
        kind: "assistant",
        streaming: false,
        showActions: true,
        parts: ["commentary", "final_answer"].map((phase, seq) => ({
          id: phase,
          type: "text",
          sessionId: "s",
          messageId: "m",
          seq,
          status: "completed",
          text: phase,
          metadata: { phase },
          createdAt: 1,
          updatedAt: 1,
        })),
      },
    ]
    act(() =>
      root.render(
        <TurnProcess
          plan={plan}
          canCollapse
          timing={{ status: "completed", startedAt: 1, finishedAt: 1000 }}
        >
          {(items) =>
            items.map((item) =>
              item.parts.some((part) => part.metadata.phase === "commentary") ? (
                <SlowProcess key={item.key} />
              ) : (
                <p key={item.key}>Answer</p>
              )
            )
          }
        </TurnProcess>
      )
    )
    act(() => container.querySelector("button")!.click())
    await paint()
    expect((container.querySelector('[role="region"]') as HTMLElement).style.height).toBe("0px")
    await paint()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const region = container.querySelector('[role="region"]') as HTMLElement
    const height = parseFloat(region.style.height)
    expect(height).toBeGreaterThan(0)
    expect(height).toBeLessThan(16000)
    expect(parseFloat(region.style.opacity)).toBeLessThan(0.5)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
  })

  it("returns focused content to the trigger without scrolling when controlled closed", () => {
    function show(open: boolean) {
      act(() =>
        root.render(
          <Collapsible open={open}>
            <CollapsibleTrigger render={<button />}>Toggle</CollapsibleTrigger>
            <CollapsibleContent>
              <input aria-label="Process field" />
            </CollapsibleContent>
          </Collapsible>
        )
      )
    }
    show(true)
    const trigger = container.querySelector("button")!
    const focus = vi.spyOn(trigger, "focus")
    act(() => container.querySelector("input")!.focus())
    show(false)
    expect(document.activeElement).toBe(trigger)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(container.querySelector("input")).toBeNull()
  })
})
