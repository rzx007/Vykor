// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"
import { PendingPromptQueue } from "../pending-prompt-queue"

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const onPromote = vi.fn(),
  onCancel = vi.fn()
function prompt(index: number) {
  return {
    input: {
      id: `input-${index}`,
      sessionId: "s",
      content: `待处理 ${index}\n第二行内容`,
      seq: index,
      delivery: "queue",
      items: [],
      attachments: [],
      metadata: {},
      createdAt: index,
    } as DesktopSessionInput,
    run: {
      id: `run-${index}`,
      sessionId: "s",
      inputId: `input-${index}`,
      status: "pending",
      metadata: {},
      createdAt: index,
      updatedAt: index,
    } as DesktopSessionRun,
  }
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(text)
  )!
}
it("counts deduplicated pending messages, folds extra rows and expands text without executing anything", async () => {
  onPromote.mockClear()
  onCancel.mockClear()
  await act(async () =>
    root.render(
      <PendingPromptQueue
        activeRunId="active"
        prompts={[1, 2, 3, 4, 5].map(prompt)}
        localSubmissions={[
          {
            id: "input-1",
            sessionId: "s",
            content: "duplicate",
            phase: "accepted",
            placement: "queue",
          },
        ]}
        onPromote={onPromote}
        onCancel={onCancel}
      />
    )
  )
  expect(host.textContent).toContain("待处理消息 · 5")
  expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(3)
  expect(host.textContent).not.toContain("duplicate")
  await act(async () => button("展开其余 2 条").click())
  expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(5)
  const first = host.querySelector('[data-slot="item"]')!
  await act(async () => first.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click())
  expect(first.querySelector('[data-slot="collapsible-content"]')?.textContent).toBe(
    "待处理 1\n第二行内容"
  )
  expect(onPromote).not.toHaveBeenCalled()
  expect(onCancel).not.toHaveBeenCalled()
  await act(async () => button("收起更多消息").click())
  expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(3)
})
it("keeps failed and in-flight actions visible beyond the fold and disables conflicting actions", async () => {
  const failed = {
    ...prompt(4),
    action: { kind: "promote" as const, phase: "failed" as const, error: "当前任务已变化" },
  }
  const pending = { ...prompt(5), action: { kind: "cancel" as const, phase: "pending" as const } }
  await act(async () =>
    root.render(
      <PendingPromptQueue
        activeRunId="active"
        prompts={[prompt(1), prompt(2), prompt(3), failed, pending, prompt(6)]}
        onPromote={onPromote}
        onCancel={onCancel}
      />
    )
  )
  expect(host.querySelectorAll('[data-slot="item"]')).toHaveLength(5)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("当前任务已变化")
  const busy = [...host.querySelectorAll('[data-slot="item"]')].find((row) =>
    row.textContent?.includes("待处理 5")
  )!
  expect(busy.querySelector<HTMLButtonElement>('[aria-label="删除待处理消息"]')?.disabled).toBe(
    true
  )
  expect(
    [...busy.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("补充到当前任务")
    )?.disabled
  ).toBe(true)
})
