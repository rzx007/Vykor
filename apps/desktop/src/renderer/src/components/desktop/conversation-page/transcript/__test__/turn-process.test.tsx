// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DesktopSessionPart, DesktopSessionTask } from "@shared/session-types"
import { TurnProcess } from "../turn-process"
import type { TurnBlockPlanItem } from "../turn-block-plan"
import { ConversationScrollerProvider } from "../conversation-scroller"
import { useConversationScroller } from "../conversation-scroll-context"

const parts: DesktopSessionPart[] = ["commentary", "final_answer"].map((phase, i) => ({
  id: phase,
  type: "text",
  status: "completed",
  sessionId: "s",
  messageId: "m",
  seq: i,
  text: i ? "最终答复" : "执行过程",
  metadata: { phase },
  createdAt: 1,
  updatedAt: 1,
}))
const plan: TurnBlockPlanItem[] = [
  { key: "m", messageId: "m", kind: "assistant", parts, streaming: false, showActions: true },
]
const timing = { status: "completed" as const, startedAt: 1000, finishedAt: 22000 }
const render = (items: TurnBlockPlanItem[]): ReactNode =>
  items.map((item) =>
    createElement("p", { key: item.key }, item.parts.map((part) => part.text).join(""))
  )

describe("turn process disclosure", () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    window.getSelection()?.removeAllRanges()
    act(() => root.unmount())
    container.remove()
  })
  function show(canCollapse: boolean, nextPlan = plan, tasks?: DesktopSessionTask[]) {
    act(() =>
      root.render(
        <TurnProcess plan={nextPlan} canCollapse={canCollapse} timing={timing} tasks={tasks}>
          {render}
        </TurnProcess>
      )
    )
  }
  it("keeps manual expansion after a virtual row unmounts and mounts again", () => {
    const showVirtualRow = (visible: boolean) =>
      act(() =>
        root.render(
          <ConversationScrollerProvider>
            {visible ? (
              <TurnProcess turnId="turn" plan={plan} canCollapse timing={timing}>
                {render}
              </TurnProcess>
            ) : null}
          </ConversationScrollerProvider>
        )
      )
    showVirtualRow(true)
    act(() => container.querySelector("button")!.click())
    expect(container.textContent).toContain("执行过程")
    showVirtualRow(false)
    showVirtualRow(true)
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("执行过程")
  })

  it("uses shared reading intent to keep a just-completed process expanded", () => {
    let scroller: NonNullable<ReturnType<typeof useConversationScroller>>
    function Reader() {
      scroller = useConversationScroller()!
      return null
    }
    const showVirtualRow = (finished: boolean) =>
      act(() =>
        root.render(
          <ConversationScrollerProvider>
            <Reader />
            <TurnProcess turnId="turn" plan={plan} canCollapse={finished} timing={timing}>
              {render}
            </TurnProcess>
          </ConversationScrollerProvider>
        )
      )
    showVirtualRow(false)
    act(() => scroller.setIntent(-1))
    showVirtualRow(true)
    expect(container.textContent).toContain("执行过程")
    expect(container.querySelector("button")).toBeNull()
  })
  it("keeps running work visible, then collapses it under its duration", () => {
    show(false)
    expect(container.textContent).toContain("执行过程")
    show(true)
    expect(container.querySelector("button")?.textContent).toContain("用时 21秒")
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("执行过程")
    expect(container.textContent).toContain("最终答复")
  })
  it.each([false, true])("rechecks scrolling when a child finishes (reading: %s)", (reading) => {
    const agent: DesktopSessionPart = {
      ...parts[0],
      id: "agent",
      type: "tool",
      toolName: "Agent",
      text: undefined,
      output: JSON.stringify({ kind: "job", jobKind: "agent", action: "created", jobId: "child" }),
    }
    const task: DesktopSessionTask = {
      id: "child",
      sessionId: "s",
      type: "agent",
      status: "running",
      description: "Research",
      cwd: "/repo",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const nextPlan = [{ ...plan[0], parts: [parts[0], agent, parts[1]] }]
    container.dataset.slot = "message-scroller-viewport"
    Object.defineProperties(container, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 400 },
    })
    container.scrollTop = 600
    show(true, nextPlan, [task])
    expect(container.querySelector("button")).toBeNull()
    if (reading) act(() => container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })))
    show(true, nextPlan, [{ ...task, status: "completed" }])
    if (reading) {
      expect(container.querySelector("button")).toBeNull()
      expect(container.textContent).toContain("执行过程")
    } else {
      expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
      expect(container.textContent).not.toContain("执行过程")
    }
  })
  it("keeps a manual expansion across updates and provides a focusable disclosure button", async () => {
    show(true)
    const button = container.querySelector("button")!
    act(() => button.click())
    expect(container.textContent).toContain("执行过程")
    show(true, [{ ...plan[0], parts: [...parts] }])
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent!.indexOf("执行过程")).toBeLessThan(
      container.textContent!.indexOf("最终答复")
    )
    await act(async () => {
      button.focus()
      expect(document.activeElement).toBe(button)
      button.click()
    })
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
  })
  it("does not collapse while the user is reading earlier content", () => {
    container.dataset.slot = "message-scroller-viewport"
    Object.defineProperties(container, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 400 },
    })
    show(false)
    const original = container.firstElementChild?.firstElementChild
    show(true)
    expect(container.textContent).toContain("执行过程")
    expect(container.querySelector("button")).toBeNull()
    expect(container.firstElementChild?.firstElementChild).toBe(original)
  })
  it.each(["wheel", "keyboard", "touch"])(
    "preserves the process after %s intent before scroll arrives",
    (method) => {
      container.dataset.slot = "message-scroller-viewport"
      Object.defineProperties(container, {
        scrollHeight: { value: 1000 },
        clientHeight: { value: 400 },
      })
      container.scrollTop = 600
      show(false)
      const original = container.firstElementChild?.firstElementChild
      act(() => {
        if (method === "wheel")
          container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
        else if (method === "keyboard")
          container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
        else container.dispatchEvent(new Event("touchstart", { bubbles: true }))
      })
      show(true)
      expect(container.textContent).toContain("执行过程")
      expect(container.querySelector("button")).toBeNull()
      expect(container.firstElementChild?.firstElementChild).toBe(original)
      expect(container.scrollTop).toBe(600)
      show(true, [{ ...plan[0], parts: [...parts] }])
      expect(container.querySelector("button")).toBeNull()
    }
  )
  it("keeps even a small scroll away from the bottom expanded", () => {
    container.dataset.slot = "message-scroller-viewport"
    Object.defineProperties(container, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 400 },
    })
    container.scrollTop = 600
    show(false)
    act(() => {
      container.scrollTop = 590
      container.dispatchEvent(new Event("scroll"))
    })
    show(true)
    expect(container.querySelector("button")).toBeNull()
    expect(container.textContent).toContain("执行过程")
    expect(container.scrollTop).toBe(590)
  })
  it("still collapses when the user returns to the bottom before completion", () => {
    container.dataset.slot = "message-scroller-viewport"
    Object.defineProperties(container, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 400 },
    })
    container.scrollTop = 600
    show(false)
    act(() => {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }))
      container.scrollTop = 580
      container.dispatchEvent(new Event("scroll"))
      container.scrollTop = 600
      container.dispatchEvent(new Event("scroll"))
    })
    show(true)
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("执行过程")
    expect(container.textContent).toContain("最终答复")
  })
  it("preserves the selected process text and its DOM when the stream completes", () => {
    show(false)
    const original = container.querySelector("p")!
    const range = document.createRange()
    range.selectNodeContents(original)
    window.getSelection()!.addRange(range)
    const selected = window.getSelection()!.toString()
    show(true)
    expect(container.querySelector("p")).toBe(original)
    expect(window.getSelection()!.toString()).toBe(selected)
    expect(container.querySelector("button")).toBeNull()
  })
  it("checks reading intent again when a previously completed turn resumes", () => {
    container.dataset.slot = "message-scroller-viewport"
    Object.defineProperties(container, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 400 },
    })
    container.scrollTop = 600
    show(true)
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
    show(false)
    act(() => container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })))
    show(true)
    expect(container.querySelector("button")).toBeNull()
    expect(container.textContent).toContain("执行过程")
  })
  it("keeps failed or ambiguous turns expanded without an empty disclosure", () => {
    show(false)
    expect(container.querySelector("button")).toBeNull()
    show(true, [{ ...plan[0], parts: [parts[1]] }])
    expect(container.querySelector("button")).toBeNull()
    expect(container.textContent).toBe("最终答复")
  })
})
