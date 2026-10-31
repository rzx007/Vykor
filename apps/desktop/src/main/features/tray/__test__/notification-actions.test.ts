import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  shown: [] as Record<string, unknown>[],
  activate: undefined as ((details: Electron.ActivationArguments) => void) | undefined,
}))
vi.mock("electron", () => ({
  Notification: class {
    static handleActivation(callback: typeof state.activate) {
      state.activate = callback
    }
    constructor(private options: Record<string, unknown>) {}
    show() {
      state.shown.push(this.options)
    }
  },
}))
vi.mock("../../settings/desktop-preferences", () => ({
  getDesktopPreferences: () => state.preferences,
  patchDesktopPreferences: (patch: Record<string, unknown>) =>
    Object.assign(state.preferences, patch),
}))

let actions: typeof import("../notification-actions")
let calls: { sessionId: string; input: unknown }[]
let approvals: { id: string; input: unknown }[]
let pending: {
  id: string
  sessionId: string
  toolName: string
  status: string
  payload: Record<string, unknown>
}[]
let navigations: string[]
let admit: (sessionId: string, input: unknown) => Promise<unknown>
let approve: (id: string, input: unknown) => Promise<{ status: string }>
let goal: {
  id: string
  sessionId: string
  objectiveVersion: number
  revision: number
  status: string
  wait?: { kind: string; questionId: string; objectiveVersion: number }
} | null
let goalCalls: { sessionId: string; goalId: string; input: unknown }[]
let resume: () => unknown

beforeEach(async () => {
  vi.resetModules()
  vi.spyOn(process, "platform", "get").mockReturnValue("win32")
  state.preferences = {}
  state.shown = []
  state.activate = undefined
  calls = []
  approvals = []
  navigations = []
  goal = null
  goalCalls = []
  resume = () => ({ ...goal, status: "active", wait: undefined })
  pending = [{ id: "p1", sessionId: "original", toolName: "Shell", status: "pending", payload: {} }]
  admit = async (sessionId, input) => {
    calls.push({ sessionId, input })
    return {}
  }
  approve = async (id, input) => {
    approvals.push({ id, input })
    return { status: "approved" }
  }
  actions = await import("../notification-actions")
  actions.initializeNotificationActions(
    async () =>
      ({
        sessions: {
          get: async (id: string) => ({ id, status: "active" }),
          admitPrompt: (id: string, input: unknown) => admit(id, input),
          getGoal: async () => goal,
          applyGoalAction: async (sessionId: string, goalId: string, input: unknown) => {
            goalCalls.push({ sessionId, goalId, input })
            return resume()
          },
        },
        permissions: {
          list: async () => pending,
          reply: (id: string, input: unknown) => approve(id, input),
        },
      }) as never,
    (id) => navigations.push(id)
  )
})

function activation(
  options: Electron.NotificationConstructorOptions,
  type: "click" | "reply" | "action",
  extra = {}
) {
  return {
    type,
    arguments: `type=${type}&tag=${options.id}`,
    ...extra,
  } as Electron.ActivationArguments
}

describe("native notification actions", () => {
  it("answers the exact goal question through resume instead of admitting an ordinary prompt", async () => {
    goal = {
      id: "goal-1",
      sessionId: "original",
      objectiveVersion: 2,
      revision: 7,
      status: "waiting_user",
      wait: { kind: "user", questionId: "q1", objectiveVersion: 2 },
    }
    const native = (await actions.notificationInteractionOptions(
      {
        title: "Vykor",
        body: "",
        sessionId: "original",
        eventStatus: "needs_input",
        attentionId: "goal:goal-1:question:q1",
      },
      "需要回答"
    ))!
    expect(native.toastXml).toContain('id="reply"')
    expect(state.preferences.notificationTargets).toMatchObject([
      { kind: "goal", goalId: "goal-1", objectiveVersion: 2, questionId: "q1" },
    ])
    await actions.handleNotificationActivation(activation(native, "reply", { reply: "选择 A" }))
    expect(calls).toEqual([])
    expect(goalCalls).toEqual([
      {
        sessionId: "original",
        goalId: "goal-1",
        input: {
          requestId: expect.any(String),
          expectedRevision: 7,
          action: "resume",
          questionId: "q1",
          objectiveVersion: 2,
          response: "选择 A",
        },
      },
    ])
    expect(state.shown.at(-1)?.body).toContain("回复已发送")
  })

  it.each(["goal", "version", "question"])(
    "does not submit a goal answer after its %s changes",
    async (changed) => {
      goal = {
        id: "goal-1",
        sessionId: "original",
        objectiveVersion: 2,
        revision: 7,
        status: "waiting_user",
        wait: { kind: "user", questionId: "q1", objectiveVersion: 2 },
      }
      const native = (await actions.notificationInteractionOptions(
        {
          title: "Vykor",
          body: "",
          sessionId: "original",
          eventStatus: "needs_input",
          attentionId: "goal:goal-1:question:q1",
        },
        "需要回答"
      ))!
      if (changed === "goal") goal.id = "goal-2"
      else if (changed === "version") goal.objectiveVersion = 3
      else goal.wait!.questionId = "q2"
      await actions.handleNotificationActivation(activation(native, "reply", { reply: "旧回答" }))
      expect(goalCalls).toEqual([])
      expect(calls).toEqual([])
      expect(state.shown.at(-1)?.body).toContain("过期")
    }
  )

  it.each(["paused", "new-question"])(
    "only opens a %s goal stop without answering another question",
    async (stop) => {
      goal = {
        id: "goal-1",
        sessionId: "original",
        objectiveVersion: 2,
        revision: 7,
        status: stop === "paused" ? "paused" : "waiting_user",
        wait: { kind: "user", questionId: "new-question", objectiveVersion: 2 },
      }
      const native = (await actions.notificationInteractionOptions(
        {
          title: "Vykor",
          body: "",
          sessionId: "original",
          eventStatus: "needs_input",
          attentionId: "goal:goal-1:question:old-question",
        },
        "需要处理"
      ))!
      expect(native.toastXml).not.toContain('id="reply"')
      await actions.handleNotificationActivation(
        activation(native, "reply", { reply: "不能错误发送" })
      )
      expect(goalCalls).toEqual([])
      expect(calls).toEqual([])
    }
  )

  it("does not report a goal reply sent when the server still waits without accepting a resume", async () => {
    goal = {
      id: "goal-1",
      sessionId: "original",
      objectiveVersion: 2,
      revision: 7,
      status: "waiting_user",
      wait: { kind: "user", questionId: "q1", objectiveVersion: 2 },
    }
    resume = () => goal
    const native = (await actions.notificationInteractionOptions(
      {
        title: "Vykor",
        body: "",
        sessionId: "original",
        eventStatus: "needs_input",
        attentionId: "goal:goal-1:question:q1",
      },
      "需要回答"
    ))!
    await actions.handleNotificationActivation(activation(native, "reply", { reply: "保留回答" }))
    expect(state.shown.at(-1)?.body).toContain("回复未发送")
    expect(state.shown.at(-1)?.toastXml).toContain('defaultInput="保留回答"')
    expect(calls).toEqual([])
  })

  it("replays a failed goal answer with the same request ID and revision after the goal becomes active", async () => {
    goal = {
      id: "goal-1",
      sessionId: "original",
      objectiveVersion: 2,
      revision: 7,
      status: "waiting_user",
      wait: { kind: "user", questionId: "q1", objectiveVersion: 2 },
    }
    const native = (await actions.notificationInteractionOptions(
      {
        title: "Vykor",
        body: "",
        sessionId: "original",
        eventStatus: "needs_input",
        attentionId: "goal:goal-1:question:q1",
      },
      "需要回答"
    ))!
    resume = () => {
      throw new Error("response lost after acceptance")
    }
    await actions.handleNotificationActivation(activation(native, "reply", { reply: "选择 A" }))
    goal = { ...goal, status: "active", revision: 9, wait: undefined }
    resume = () => goal
    await actions.handleNotificationActivation(activation(native, "reply", { reply: "选择 A" }))
    expect(goalCalls).toHaveLength(2)
    expect(goalCalls[1]!.input).toEqual(goalCalls[0]!.input)
    expect(state.shown.at(-1)?.body).toContain("回复已发送")
    expect(calls).toEqual([])
  })

  it("restores the original target after a process restart and ignores unknown targets", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original" },
      "完成"
    ))!
    expect(native.toastXml).toContain("type=action&amp;action=2")
    const preferences = structuredClone(state.preferences)
    await vi.resetModules()
    actions = await import("../notification-actions")
    actions.initializeNotificationActions(
      async () => ({}) as never,
      (id) => navigations.push(id)
    )
    state.preferences = preferences
    await actions.handleNotificationActivation(activation(native, "click"))
    await actions.handleNotificationActivation({
      type: "action",
      arguments: "tag=unknown",
      actionIndex: 0,
    })
    expect(navigations).toEqual(["original"])
  })

  it("sends a reply to its original chat once even when both callbacks arrive", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original" },
      "完成"
    ))!
    const reply = activation(native, "reply", { reply: "继续处理" })
    await Promise.all([
      actions.handleNotificationActivation(reply),
      actions.handleNotificationActivation(reply),
    ])
    await actions.handleNotificationActivation(reply)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: "original",
      input: {
        items: [{ type: "text", text: "继续处理" }],
        delivery: "queue",
        metadata: { origin: { component: "notification" } },
      },
    })
  })

  it("keeps a failed reply and uses the same input ID when the user retries", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original" },
      "完成"
    ))!
    const ids: unknown[] = []
    admit = async (_session, input) => {
      ids.push((input as { id: string }).id)
      throw new Error("network")
    }
    await actions.handleNotificationActivation(
      activation(native, "reply", { reply: "保留这条回复" })
    )
    expect(state.shown.at(-1)?.toastXml).toContain('defaultInput="保留这条回复"')
    admit = async (_session, input) => {
      ids.push((input as { id: string }).id)
      return {}
    }
    await actions.handleNotificationActivation(
      activation(native, "reply", { reply: "保留这条回复" })
    )
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(JSON.stringify(state.preferences)).not.toContain("保留这条回复")
  })

  it("offers only one-time approval and refusal, bound to the original request", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original", permissionId: "p1" },
      "需要批准"
    ))!
    expect(native.toastXml).toContain('content="允许本次"')
    expect(native.toastXml).toContain('content="拒绝"')
    await actions.handleNotificationActivation(activation(native, "action", { actionIndex: 0 }))
    expect(approvals).toEqual([
      { id: "p1", input: { status: "approved", decision: "once", clientId: "desktop" } },
    ])
    expect(calls).toEqual([])
  })

  it("refuses through the permission endpoint and ignores a malformed action", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original", permissionId: "p1" },
      "需要批准"
    ))!
    await actions.handleNotificationActivation(activation(native, "action"))
    expect(approvals).toEqual([])
    approve = async (id, input) => {
      approvals.push({ id, input })
      return { status: "denied" }
    }
    await actions.handleNotificationActivation(activation(native, "action", { actionIndex: 1 }))
    expect(approvals).toEqual([
      { id: "p1", input: { status: "denied", decision: "once", clientId: "desktop" } },
    ])
  })

  it("retains a reply even if connecting to the background fails", async () => {
    const native = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original" },
      "完成"
    ))!
    actions.initializeNotificationActions(
      async () => {
        throw new Error("offline")
      },
      (id) => navigations.push(id)
    )
    await actions.handleNotificationActivation(
      activation(native, "reply", { reply: "后台恢复后继续" })
    )
    expect(state.shown.at(-1)?.toastXml).toContain('defaultInput="后台恢复后继续"')
    expect(JSON.stringify(state.preferences)).toContain("后台恢复后继续")
  })

  it("does not approve AskUser, missing, or expired requests and checks the returned status", async () => {
    pending[0]!.toolName = "AskUser"
    const question = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original", permissionId: "p1" },
      "需要回答"
    ))!
    expect(question.toastXml).not.toContain('content="允许本次"')
    await actions.handleNotificationActivation(activation(question, "action", { actionIndex: 0 }))
    expect(approvals).toEqual([])

    pending[0]!.toolName = "Shell"
    const approval = (await actions.notificationInteractionOptions(
      { title: "Vykor", body: "", sessionId: "original", permissionId: "p1" },
      "需要批准"
    ))!
    approve = async () => ({ status: "expired" })
    await actions.handleNotificationActivation(activation(approval, "action", { actionIndex: 0 }))
    expect(state.shown.at(-1)?.body).toContain("过期")
    pending = []
    await actions.handleNotificationActivation(activation(approval, "action", { actionIndex: 1 }))
    expect(approvals).toEqual([])
  })
})
