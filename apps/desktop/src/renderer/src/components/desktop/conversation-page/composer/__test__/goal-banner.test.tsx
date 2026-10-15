// @vitest-environment jsdom
import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { SessionGoal } from "@shared/session-types"
import { GoalBanner } from "../goal-banner"
import { Composer } from "../composer"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}))

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
  objectiveVersion: 1,
  phase: "executing", requirements: [], stagnationCount: 0,
  status: "paused",
  autoTurnsUsed: 20,
  maxAutoTurns: 20,
  noProgressCount: 0,
  evidence: ["测试记录"],
  usage: { knownTokens: 0, incomplete: false, unknownAttempts: 0, partialAttempts: 0, inFlightAttempts: 0, runTimeMs: 0, seq: 0, updatedAt: 1 },
  createdAt: 1,
  updatedAt: 2,
}
const button = (label: string): HTMLButtonElement =>
  Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label
  )!

it("keeps preparation restart explicit and separate from ordinary resume", async () => {
  const onAction = vi.fn()
  await act(async () => root.render(createElement(GoalBanner, { goal: { ...goal, phase: "preparing", autoTurnsUsed: 0 }, busy: false, stopping: false, onAction, onEdit: vi.fn(), onDismiss: vi.fn() })))
  await act(async () => button("继续").click())
  expect(onAction).toHaveBeenCalledWith({ action: "resume" })
  await act(async () => button("展开目标详情").click())
  await act(async () => button("重新整理目标").click())
  expect(onAction).toHaveBeenCalledWith({ action: "resume", reprepare: true })
})

it("accepts only the displayed current-version user requirements", async () => {
  const onAction = vi.fn()
  await act(async () => root.render(createElement(GoalBanner, { goal: { ...goal, status: "waiting_user", autoTurnsUsed: goal.maxAutoTurns,
    requirements: [{ id: "R1", text: "页面符合预期", source: [{ kind: "input", inputId: "i", quote: "页面" }], constraints: [], verification: { kind: "user_acceptance", question: "页面符合预期？" } }],
    wait: { kind: "user", purpose: "acceptance", objectiveVersion: 1, questionId: "q", question: "验收", requirementIds: ["R1"] } },
    busy: false, stopping: false, onAction, onEdit: vi.fn(), onDismiss: vi.fn() })))
  expect(container.textContent).toContain("页面符合预期")
  expect(container.querySelector('[aria-label="回答目标问题"]')).toBeNull()
  await act(async () => button("结果满足所列条件").click())
  expect(onAction).toHaveBeenCalledWith({ action: "confirm", objectiveVersion: 1, questionId: "q" })
})

it("keeps execution metadata behind a second disclosure and exposes no budget form", async () => {
  await act(async () => root.render(createElement(GoalBanner, {
    goal: { ...goal, maxAutoTurns: 0, autoTurnsUsed: 0, versionSummary: { changeKind: "create", changeReason: "用户创建目标", createdAt: 1 },
      usage: { ...goal.usage, knownTokens: 10608, runTimeMs: 21000 } },
    busy: false, stopping: false, onAction: vi.fn(), onEdit: vi.fn(), onDismiss: vi.fn(),
  })))
  await act(async () => button("展开目标详情").click())
  expect(container.textContent).not.toContain("10,608 Token")
  expect(container.textContent).not.toContain("用户创建目标")
  expect(container.querySelector('[aria-label="修改 Token 总预算"]')).toBeNull()
  expect(button("保存总预算")).toBeUndefined()
  expect(button("运行详情").getAttribute("aria-expanded")).toBe("false")
  await act(async () => button("运行详情").click())
  expect(container.textContent).toContain("10,608 Token")
  expect(container.textContent).toContain("用户创建目标")
  expect(container.textContent).toContain("21 秒")
  await act(async () => button("运行详情").click())
  expect(container.textContent).not.toContain("10,608 Token")
})

it("removes an existing Token limit from secondary details without resuming", async () => {
  const onAction = vi.fn();
  await act(async () => root.render(createElement(GoalBanner, { goal: { ...goal, tokenBudget: 20, usage: { ...goal.usage, knownTokens: 25, seq: 1 } }, busy: false, stopping: false, onAction, onEdit: vi.fn(), onDismiss: vi.fn() })));
  await act(async () => button("展开目标详情").click());
  await act(async () => button("运行详情").click());
  expect(container.textContent).toContain("25 Token");
  expect(container.querySelector('[aria-label="修改 Token 总预算"]')).toBeNull();
  await act(async () => button("解除 Token 限制").click());
  expect(onAction).toHaveBeenCalledWith({ action: "budget", tokenBudget: null });
  expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "resume" }));
});

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
  expect(container.querySelector('[aria-label="增加自动续跑次数"]')).not.toBeNull()
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

it("keeps goal limits hidden until settings open and preserves submit and exit behavior", async () => {
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
  const onGoalAutoTurnsChange = vi.fn()
  await act(async () => root.render(createElement(Composer, { ...props, running: false, onGoalAutoTurnsChange, onGoalTokenBudgetChange: vi.fn() })))
  expect(document.querySelector('[aria-label="自动续跑额度"]')).toBeNull()
  expect(document.querySelector('[aria-label="Token 总预算"]')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="目标设置"]')!.click())
  const turns = document.querySelector<HTMLInputElement>('[aria-label="自动续跑额度"]')!
  expect(turns.value).toBe("")
  expect(turns.placeholder).toBe("不限")
  expect(document.querySelector<HTMLInputElement>('[aria-label="Token 总预算"]')!.value).toBe("")
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="退出目标输入"]')!.click())
  expect(props.onGoalModeChange).toHaveBeenCalledWith(false)
})

it("hides the answer form during editing and restores it without losing the answer", async () => {
  const props = { goal: { ...goal, status: "waiting_user" as const, wait: { kind: "user" as const, purpose: "clarification" as const,
    goalId: goal.id, objectiveVersion: 1, questionId: "q-edit", question: "需要处理哪个模块？" } },
    busy: false, stopping: false, onAction: vi.fn(), onEdit: vi.fn(), onDismiss: vi.fn() }
  await act(async () => root.render(createElement(GoalBanner, props)))
  const answer = container.querySelector<HTMLTextAreaElement>('[aria-label="回答目标问题"]')!
  expect(answer.tagName).toBe("TEXTAREA")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(answer, "协议模块")
    answer.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => root.render(createElement(GoalBanner, { ...props, editing: true })))
  expect(container.querySelector('[aria-label="回答目标问题"]')).toBeNull()
  await act(async () => root.render(createElement(GoalBanner, { ...props, editing: false })))
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="回答目标问题"]')?.value).toBe("协议模块")
})

it("allows saving a preparation answer while its Token budget is closed", async () => {
  const onAction = vi.fn()
  await act(async () => root.render(createElement(GoalBanner, {
    goal: { ...goal, phase: "preparing", status: "waiting_user", tokenBudget: 1, usage: { ...goal.usage, knownTokens: 1 },
      wait: { kind: "user", purpose: "clarification", objectiveVersion: 1, questionId: "q-budget", question: "需要处理哪个模块？" } },
    busy: false, stopping: false, onAction, onEdit: vi.fn(), onDismiss: vi.fn(),
  })))
  const answer = container.querySelector<HTMLTextAreaElement>('[aria-label="回答目标问题"]')!
  expect(answer.disabled).toBe(false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(answer, "协议模块")
    answer.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button("保存补充").click())
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "resume", questionId: "q-budget", objectiveVersion: 1, response: "协议模块" })
})

it("requires confirmation to cancel a goal", async () => {
  const onAction = vi.fn()
  await act(async () => root.render(createElement(GoalBanner, { goal, busy: false, stopping: false, onAction, onEdit: vi.fn(), onDismiss: vi.fn() })))
  await act(async () => button("取消目标").click())
  expect(onAction).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保留会话")
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(item => item.textContent === "取消目标")!
  await act(async () => confirm.click())
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "cancel" })
})

it("provides explicit save and cancel actions while editing a prefilled goal", async () => {
  const onGoalModeChange = vi.fn()
  const onSubmit = vi.fn()
  function EditableGoal() {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(composerDocument([{ type: "text", text: "原聊天草稿" }]))
    const changeMode = (active: boolean) => {
      setEditing(active)
      setDraft(composerDocument([{ type: "text", text: active ? "原来的完整目标" : "原聊天草稿" }]))
      onGoalModeChange(active)
    }
    return createElement("div", null,
      !editing ? createElement("button", { onClick: () => changeMode(true) }, "编辑目标") : null,
      createElement(Composer, { id: "edit-goal", draft, sending: false, goalMode: editing, goalEditing: editing,
        models: [], selectedModel: "test", selectedProvider: null, modelLabel: "test", permissionMode: "default", effort: null,
        onDraftChange: setDraft, onSubmit, onGoalModeChange: changeMode, onSelectModel: vi.fn(), onSelectPermissionMode: vi.fn(), onSelectEffort: vi.fn() }))
  }
  await act(async () => root.render(createElement(EditableGoal)))
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("原聊天草稿")
  await act(async () => button("编辑目标").click())
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("原来的完整目标")
  await act(async () => button("保存目标").click())
  expect(onSubmit).toHaveBeenCalledOnce()
  await act(async () => button("取消编辑").click())
  expect(onGoalModeChange).toHaveBeenLastCalledWith(false)
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("原聊天草稿")
})

it("keeps acceptance progress behind a secondary disclosure without exposing internal IDs", async () => {
  await act(async () =>
    root.render(
      createElement(GoalBanner, {
        goal: {
          ...goal,
          requirements: [
            { id: "R1", text: "测试通过", constraints: [], source: [{ kind: "input", inputId: "i", quote: "测试" }], verification: { kind: "check", method: "测试", environment: "local", expected: "通过" } },
            { id: "R2", text: "补充文档", constraints: [], source: [{ kind: "input", inputId: "i", quote: "文档" }], verification: { kind: "user_acceptance", question: "文档满足条件？" } },
          ],
          assessment: {
            goalId: "g1",
            objectiveVersion: 1,
            runId: "r1",
            decision: "continue",
            progress: "完成测试",
            progressAssessment: { kind: "progress", summary: "测试已通过" },
            evidence: ["测试记录"],
            evidenceRefs: [],
            requirements: [
              {
                requirementId: "R1", explanation: "测试通过",
                status: "satisfied",
                evidenceRefs: [],
              },
              {
                requirementId: "R2", explanation: "文档未完成",
                status: "incomplete",
                evidenceRefs: [],
              },
            ],
            remainingWork: ["补充文档"],
            nextStep: "补充文档",
          },
        },
        busy: false,
        stopping: false,
        onAction: vi.fn(),
        onEdit: vi.fn(),
        onDismiss: vi.fn(),
      })
    )
  )
  await act(async () => button("展开目标详情").click())
  expect(container.textContent).not.toContain("测试通过")
  expect(container.textContent).not.toContain("补充文档")
  expect(container.textContent).not.toContain("测试记录")
  expect(button("验收进度").getAttribute("aria-expanded")).toBe("false")
  expect(button("验收进度").textContent).toContain("1 / 2 已满足")
  await act(async () => button("验收进度").click())
  const details = container.querySelector('[aria-label="验收明细"]')!
  expect(details.textContent).toMatch(/测试通过\s*已满足/)
  expect(details.textContent).toMatch(/补充文档\s*未完成/)
  expect(details.textContent).toContain("剩余工作")
  expect(details.textContent).toContain("测试记录")
  expect(details.textContent).not.toContain("R1")
  expect(details.textContent).not.toContain("R2")
  await act(async () => button("收起目标详情").click())
  await act(async () => button("展开目标详情").click())
  expect(container.querySelector('[aria-label="验收明细"]')).toBeNull()
})

it("shows unchecked conditions as pending rather than failed and keeps acceptance waits distinct", async () => {
  const props = {
    goal: { ...goal, maxAutoTurns: 0, requirements: [
      { id: "R1-1", text: "验证文件内容", constraints: [], source: [{ kind: "input" as const, inputId: "i", quote: "文件内容" }], verification: { kind: "user_acceptance" as const, question: "文件内容符合预期？" } },
    ] },
    busy: false, stopping: false, onAction: vi.fn(), onEdit: vi.fn(), onDismiss: vi.fn(),
  }
  await act(async () => root.render(createElement(GoalBanner, props)))
  await act(async () => button("展开目标详情").click())
  expect(button("验收进度").textContent).toContain("1 项待检查")
  await act(async () => button("验收进度").click())
  expect(container.querySelector('[aria-label="验收明细"]')?.textContent).toMatch(/验证文件内容\s*待检查/)
  expect(container.textContent).not.toContain("未完成")
  const wait = { kind: "user" as const, purpose: "acceptance" as const, objectiveVersion: 1, questionId: "q", question: "文件内容符合预期？", requirementIds: ["R1-1"] }
  await act(async () => root.render(createElement(GoalBanner, { ...props, goal: { ...props.goal,
    status: "waiting_user", wait,
    assessment: { goalId: "g1", objectiveVersion: 1, runId: "r1", decision: "waiting_user", progress: "等待验收", evidence: [], evidenceRefs: [],
      progressAssessment: { kind: "waiting", summary: "等待验收" }, wait,
      requirements: [{ requirementId: "R1-1", status: "needs_user", explanation: "请验收", evidenceRefs: [] }] },
  } })))
  expect(container.querySelector('[aria-label="验收明细"]')?.textContent).toMatch(/验证文件内容\s*待验收/)
})
