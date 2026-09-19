// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { SessionGoal } from "@shared/session-types"
import { GoalBanner } from "../goal-banner"
import { Composer } from "../composer"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"

let root: Root
let container: HTMLDivElement
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
const goal: SessionGoal = {
  id: "g1",
  sessionId: "s1",
  revision: 1,
  objective: "修复并验证",
  status: "paused",
  autoTurnsUsed: 20,
  maxAutoTurns: 20,
  noProgressCount: 0,
  evidence: ["测试记录"],
  createdAt: 1,
  updatedAt: 2,
}
const button = (label: string): HTMLButtonElement =>
  Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label
  )!

it("requires an explicit quota increase before resuming an exhausted goal", async () => {
  const onAction = vi.fn()
  await act(async () =>
    root.render(
      createElement(GoalBanner, {
        goal,
        busy: false,
        stopping: false,
        onAction,
        onEdit: vi.fn(),
        onDismiss: vi.fn(),
      })
    )
  )
  await act(async () => button("继续").click())
  expect(onAction).not.toHaveBeenCalled()
  expect(container.textContent).toContain("测试记录")
  await act(async () => button("增加次数并继续").click())
  expect(onAction).toHaveBeenCalledWith({ action: "resume", additionalAutoTurns: 20 })
})

it("does not expose a resume or completion shortcut for approval waits", async () => {
  const onAction = vi.fn()
  await act(async () =>
    root.render(
      createElement(GoalBanner, {
        goal: {
          ...goal,
          status: "waiting_user",
          wait: { kind: "approval", permissionRequestId: "p1" },
        },
        busy: false,
        stopping: false,
        onAction,
        onEdit: vi.fn(),
        onDismiss: vi.fn(),
      })
    )
  )
  expect(container.textContent).toContain("授权请求")
  expect(button("答复并继续")).toBeUndefined()
  expect(button("确认目标已完成")).toBeUndefined()
  expect(onAction).not.toHaveBeenCalled()
})

it("offers submit while editing a running goal and disables mode exit during submission", () => {
  const props = {
    id: "goal-composer",
    draft: composerDocument([{ type: "text" as const, text: "新目标" }]),
    sending: false,
    running: true,
    goalMode: true,
    models: [],
    selectedModel: "test",
    selectedProvider: null,
    modelLabel: "test",
    permissionMode: "default" as const,
    effort: null,
    canSubmit: true,
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onGoalModeChange: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectPermissionMode: vi.fn(),
    onSelectEffort: vi.fn(),
  }
  const markup = renderToStaticMarkup(createElement(Composer, props))
  expect(markup).toContain('aria-label="发送"')
  expect(markup).not.toContain('aria-label="停止生成"')
  const busy = document.createElement("div")
  busy.innerHTML = renderToStaticMarkup(createElement(Composer, { ...props, sending: true }))
  expect(busy.querySelector<HTMLButtonElement>('[aria-label="退出目标输入"]')?.disabled).toBe(true)
})

it("shows requirement status and remaining work in goal details", async () => {
  await act(async () =>
    root.render(
      createElement(GoalBanner, {
        goal: {
          ...goal,
          assessment: {
            goalId: "g1",
            revision: 1,
            runId: "r1",
            decision: "continue",
            progress: "完成测试",
            progressAssessment: { kind: "progress", summary: "测试已通过" },
            evidence: ["测试记录"],
            evidenceRefs: [],
            requirements: [
              {
                requirement: "测试通过",
                source: "目标正文",
                status: "satisfied",
                evidenceRefs: [],
              },
              {
                requirement: "补充文档",
                source: "目标正文",
                status: "incomplete",
                evidenceRefs: [],
              },
            ],
            remainingWork: ["补充文档"],
            nextStep: "补充文档",
          },
        } as any,
        busy: false,
        stopping: false,
        onAction: vi.fn(),
        onEdit: vi.fn(),
        onDismiss: vi.fn(),
      })
    )
  )
  await act(async () => button("展开目标详情").click())
  expect(container.textContent).toContain("测试通过：已满足")
  expect(container.textContent).toContain("补充文档：未完成")
  expect(container.textContent).toContain("剩余工作：补充文档")
})
