// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopScheduledTask } from "@shared/schedule-types"
import { DetailPanel } from "../scheduled-detail"

vi.mock("@renderer/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function makeTask(overrides: Partial<DesktopScheduledTask> = {}): DesktopScheduledTask {
  return {
    id: "task-1",
    name: "每晚汇总",
    prompt: "汇总今天的提交",
    recurrence: "FREQ=DAILY;BYHOUR=22",
    recurrenceFormat: "rrule",
    timezone: "Asia/Shanghai",
    status: "active",
    destination: "standalone",
    projectPaths: [],
    executionMode: "local",
    skillNames: [],
    pluginNames: [],
    permissionProfile: { mode: "workspace_write" },
    overlapPolicy: "skip",
    missedRunPolicy: "skip",
    createdBy: "user",
    runCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("Scheduled detail actions", () => {
  let root: Root
  let container: HTMLDivElement
  let onBack: () => void
  let onRunNow: () => void
  let onEdit: () => void
  let onToggle: () => void
  let onDelete: () => void
  let onOpenSession: (sessionId: string) => void

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    onBack = vi.fn()
    onRunNow = vi.fn()
    onEdit = vi.fn()
    onToggle = vi.fn()
    onDelete = vi.fn()
    onOpenSession = vi.fn()
  })

  afterEach(() => {
    act(() => root.render(null))
    container.remove()
  })

  async function renderDetail(
    task: DesktopScheduledTask = makeTask(),
    busy: string | null = null
  ): Promise<void> {
    await act(async () => {
      root.render(
        <DetailPanel
          task={task}
          runs={[]}
          busy={busy}
          onBack={onBack}
          onRunNow={onRunNow}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onOpenSession={onOpenSession}
        />
      )
    })
  }

  function findButton(label: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  }

  function findOverflowToggle(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>("button[aria-expanded]")
  }

  async function click(label: string): Promise<void> {
    const button = findButton(label)
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
    })
  }

  it("keeps run and toggle on the rail and hides edit and delete behind the overflow toggle", async () => {
    await renderDetail()

    expect(findButton("立即运行任务")).not.toBeNull()
    expect(findButton("暂停任务")).not.toBeNull()
    expect(findButton("关闭详情")).not.toBeNull()
    expect(findButton("编辑任务")).toBeNull()
    expect(findButton("删除任务")).toBeNull()

    const toggle = findOverflowToggle()
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
  })

  it("reveals the overflow actions and collapses the rail once one is used", async () => {
    await renderDetail()

    await click("更多任务操作")
    const toggle = findOverflowToggle()
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(findButton("编辑任务")).not.toBeNull()
    expect(findButton("删除任务")).not.toBeNull()

    await click("编辑任务")
    expect(onEdit).toHaveBeenCalledOnce()
    expect(findOverflowToggle()?.getAttribute("aria-expanded")).toBe("false")
  })

  it("runs delete from the overflow group and collapses the rail", async () => {
    await renderDetail()

    await click("更多任务操作")
    await click("删除任务")

    expect(onDelete).toHaveBeenCalledOnce()
    expect(findOverflowToggle()?.getAttribute("aria-expanded")).toBe("false")
  })

  it("closes the overflow rail on an outside pointerdown", async () => {
    await renderDetail()

    await click("更多任务操作")
    expect(findOverflowToggle()?.getAttribute("aria-expanded")).toBe("true")

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    })

    expect(findOverflowToggle()?.getAttribute("aria-expanded")).toBe("false")
  })

  it("drops the toggle action for a completed task", async () => {
    await renderDetail(makeTask({ status: "completed" }))

    expect(findButton("立即运行任务")).not.toBeNull()
    expect(findButton("暂停任务")).toBeNull()
    expect(findButton("继续任务")).toBeNull()
  })

  it("disables every action while a mutation is in flight", async () => {
    await renderDetail(makeTask(), "toggle")

    expect(findButton("立即运行任务")?.disabled).toBe(true)
    expect(findButton("暂停任务")?.disabled).toBe(true)
    expect(findButton("关闭详情")?.disabled).toBe(false)

    await click("更多任务操作")
    expect(findButton("编辑任务")?.disabled).toBe(true)
    expect(findButton("删除任务")?.disabled).toBe(true)
  })

  it("wires run, close and overflow callbacks", async () => {
    await renderDetail()

    await click("立即运行任务")
    expect(onRunNow).toHaveBeenCalledOnce()

    await click("暂停任务")
    expect(onToggle).toHaveBeenCalledOnce()

    await click("关闭详情")
    expect(onBack).toHaveBeenCalledOnce()
  })
})
