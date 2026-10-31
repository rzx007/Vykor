import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import {
  createInitialClientState,
  type ScheduledRunRecord,
  type SessionEventRecord,
} from "@vykor/application-client"
import { WindowManager } from "../core/services/window-manager"
import { reduceActivityEvent } from "../features/activity/activity-reducer"
import {
  projectScheduledActivity,
  projectSessionActivity,
} from "../features/activity/activity-projection"
import {
  applyActivityUpdate,
  createActivityState,
} from "../../renderer/src/stores/desktop-session/activity-state"
import { trayIpcContribution } from "../features/tray/ipc"
import { initializeNotificationActions } from "../features/tray/notification-actions"
import type { DesktopNotificationTarget } from "../features/settings/desktop-preferences-storage"
import { IpcChannels, IpcEvents, type TrayNotificationOptions } from "../../shared/ipc-channels"

const runtime = vi.hoisted(() => ({
  focusedWindow: null as unknown,
  shown: [] as Electron.NotificationConstructorOptions[],
  activate: undefined as ((details: Electron.ActivationArguments) => void) | undefined,
  nativeNotifications: [] as Array<{ emit(event: string): boolean }>,
  preferences: {
    notificationMode: "when_unfocused" as "when_unfocused" | "always" | "never",
    notificationEvents: { completed: true, failed: true, needs_input: true },
    notifiedEventIds: [] as string[],
    notificationTargets: [] as DesktopNotificationTarget[],
  },
}))

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    app: { getName: () => "Vykor", setBadgeCount: () => true },
    BrowserWindow: class {
      static getFocusedWindow = () => runtime.focusedWindow
    },
    Menu: {},
    nativeImage: { createFromBitmap: (bitmap: Buffer) => bitmap },
    Notification: class extends EventEmitter {
      static isSupported = () => true
      static handleActivation(callback: typeof runtime.activate) { runtime.activate = callback }
      constructor(private readonly options: { title: string; body: string; silent?: boolean }) {
        super()
        runtime.nativeNotifications.push(this)
      }
      show() {
        runtime.shown.push(this.options)
        this.emit("show")
      }
    },
    Tray: class {},
  }
})
vi.mock("../features/settings/desktop-preferences", () => ({
  getDesktopPreferences: () => runtime.preferences,
  patchDesktopPreferences: (patch: Partial<typeof runtime.preferences>) =>
    Object.assign(runtime.preferences, patch),
}))

beforeEach(() => {
  runtime.focusedWindow = null
  runtime.shown = []
  runtime.nativeNotifications = []
  runtime.preferences.notificationMode = "when_unfocused"
  runtime.preferences.notificationEvents = { completed: true, failed: true, needs_input: true }
  runtime.preferences.notifiedEventIds = []
  runtime.preferences.notificationTargets = []
})

type Focus = "external" | "pet" | "hidden" | "minimized" | "main"
type NoticeKind = "completed" | "failed" | "permission" | "AskUser"

function permissionFlow(
  focus: Focus,
  options: { scheduled?: boolean; legacyScheduledTask?: boolean } = {}
) {
  const windowManager = new WindowManager()
  const mainState = {
    visible: focus !== "hidden",
    minimized: focus === "minimized",
    focused: focus === "main",
  }
  const windowActions: string[] = []
  const rendererMessages: Array<{ channel: string; sessionId: string }> = []
  const main = {
    isDestroyed: () => false,
    isVisible: () => mainState.visible,
    isMinimized: () => mainState.minimized,
    isFocused: () => mainState.focused,
    setOverlayIcon: () => {},
    restore() {
      windowActions.push("restore")
      mainState.minimized = false
    },
    show() {
      windowActions.push("show")
      mainState.visible = true
    },
    focus() {
      windowActions.push("focus")
      mainState.focused = true
      runtime.focusedWindow = main
    },
    webContents: {
      send(channel: string, sessionId: string) {
        windowActions.push("send")
        rendererMessages.push({ channel, sessionId })
      },
    },
  } as unknown as BrowserWindow
  const pet = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
  } as BrowserWindow
  windowManager.set("main", main)
  windowManager.set("pet", pet)
  runtime.focusedWindow = focus === "pet" ? pet : focus === "main" ? main : null
  const notify = trayIpcContribution
    .register({ windowManager } as never)
    .find((item) => item.channel === IpcChannels.trayNotify)!.handler
  const session = {
    id: "session",
    cwd: "/workspace",
    title: "SECRET private task",
    model: "offline",
    status: "running" as const,
    metadata: options.legacyScheduledTask ? { scheduledTask: true } : {},
    createdAt: 1,
    updatedAt: 1,
  }
  const run = {
    id: "run",
    sessionId: session.id,
    status: "running",
    metadata: options.scheduled ? { scheduledRunId: "scheduled-run" } : {},
    createdAt: 2,
    updatedAt: 2,
  }
  const scheduledRun: ScheduledRunRecord = {
    id: "scheduled-run",
    taskId: "scheduled-task",
    cause: "scheduled",
    status: "running",
    scheduledFor: 2,
    sessionId: session.id,
    runId: run.id,
    unread: false,
    createdAt: 2,
    startedAt: 2,
    updatedAt: 2,
  }
  let cursor = 0
  let activeSessionId = session.id
  const delivered: TrayNotificationOptions[] = []
  const event = (type: string, payload: Record<string, unknown>): SessionEventRecord => ({
    id: `event-${++cursor}`,
    seq: cursor,
    type,
    payload,
    sessionId: session.id,
    schemaVersion: 1,
    createdAt: cursor,
  })
  let clientState = reduceActivityEvent(
    createInitialClientState(),
    event("session.created", { session })
  )
  clientState = reduceActivityEvent(
    clientState,
    event("session.run.created", {
      run,
    })
  )
  let activityState = applyActivityUpdate(
    createActivityState(),
    {
      cursor,
      delivery: "baseline",
      sessions: [projectSessionActivity(clientState, session.id, cursor)!],
      scheduled: options.scheduled ? [projectScheduledActivity(scheduledRun, cursor)] : [],
    },
    session.id
  ).state
  function deliver(record: SessionEventRecord, delivery: "live" | "catchup" = "live") {
    clientState = reduceActivityEvent(clientState, record)
    const scheduled = record.type.startsWith("scheduled.run.")
    const result = applyActivityUpdate(
      activityState,
      {
        cursor,
        delivery,
        eventType: record.type,
        sessions: scheduled ? [] : [projectSessionActivity(clientState, session.id, cursor)!],
        scheduled: scheduled
          ? [projectScheduledActivity(record.payload.run as ScheduledRunRecord, cursor)]
          : [],
      },
      activeSessionId
    )
    activityState = result.state
    for (const notice of result.notifications) {
      if (
        notice.status !== "completed" &&
        notice.status !== "failed" &&
        notice.status !== "needs_input"
      )
        throw new Error(`Unexpected native notification status: ${notice.status}`)
      const payload: TrayNotificationOptions = {
        title: notice.title,
        body: notice.body,
        sessionId: notice.sessionId,
        ...(notice.permissionId ? { permissionId: notice.permissionId } : {}),
        ...(notice.attentionId ? { attentionId: notice.attentionId } : {}),
        eventStatus: notice.status,
        eventId: notice.eventId,
        silent: true,
      }
      delivered.push(payload)
      notify({} as never, payload)
    }
  }
  const flow = {
    delivered,
    mainState,
    windowActions,
    rendererMessages,
    selectSession(sessionId: string) {
      activeSessionId = sessionId
    },
    ask(reviewStatus?: string, delivery: "live" | "catchup" = "live", toolName = "Shell") {
      const asked = event("permission.asked", {
        request: {
          id: "approval",
          sessionId: session.id,
          runId: "run",
          toolName,
          status: "pending",
          payload: {
            input: { command: "SECRET command", question: "SECRET question" },
            ...(reviewStatus ? { approvalReview: { status: reviewStatus } } : {}),
          },
          createdAt: 3,
          updatedAt: cursor + 1,
        },
      })
      deliver(asked, delivery)
    },
    finish(status: "completed" | "failed", delivery: "live" | "catchup" = "live") {
      deliver(
        event("session.run.updated", {
          run: {
            ...run,
            status,
            ...(status === "failed" ? { error: "SECRET failure details" } : {}),
            updatedAt: cursor + 1,
          },
        }),
        delivery
      )
    },
    scheduled(
      status: "succeeded" | "failed" | "needs_attention",
      delivery: "live" | "catchup" = "live"
    ) {
      deliver(
        event("scheduled.run.updated", {
          run: {
            ...scheduledRun,
            status,
            summary: "SECRET scheduled output",
            error: "SECRET scheduled failure",
            attentionReason: "SECRET scheduled question",
            unread: true,
            finishedAt: cursor + 1,
            updatedAt: cursor + 1,
          },
        }),
        delivery
      )
    },
    trigger(kind: NoticeKind, delivery: "live" | "catchup" = "live") {
      if (kind === "AskUser") flow.ask(undefined, delivery, "AskUser")
      else if (kind === "permission") flow.ask(undefined, delivery)
      else flow.finish(kind, delivery)
    },
  }
  return flow
}

describe("permission events reach native notification delivery", () => {
  it.each(["external", "pet"] as const)(
    "notifies once for the current chat while focus is on %s",
    (focus) => {
      const flow = permissionFlow(focus)
      flow.ask()
      flow.ask()
      expect(runtime.shown).toEqual([
        { title: "Vykor 需要处理", body: "任务正在等待你处理。", silent: true },
      ])
      expect(runtime.preferences.notifiedEventIds).toEqual([
        "session:session:run:approval:needs_input",
      ])
    }
  )

  it("respects the foreground-only suppression when the conversation window is focused", () => {
    permissionFlow("main").ask()
    expect(runtime.shown).toEqual([])
    expect(runtime.preferences.notifiedEventIds).toEqual([])
  })

  it.each(["ask_user", "timed_out"])(
    "notifies only when automatic review hands the same request to %s",
    (status) => {
      const flow = permissionFlow("pet")
      flow.ask("reviewing")
      expect(runtime.shown).toEqual([])
      flow.ask(status)
      flow.ask(status)
      expect(runtime.shown).toHaveLength(1)
    }
  )

  it.each(["never", "event_disabled"] as const)(
    "honors %s notification preferences after an actual permission event",
    (preference) => {
      if (preference === "never") runtime.preferences.notificationMode = "never"
      else runtime.preferences.notificationEvents.needs_input = false
      permissionFlow("pet").ask()
      expect(runtime.shown).toEqual([])
    }
  )

  it("does not alert for a pending request delivered by history catchup", () => {
    permissionFlow("pet").ask(undefined, "catchup")
    expect(runtime.shown).toEqual([])
  })
})

const sessionNotices = [
  {
    kind: "completed",
    status: "completed",
    body: "任务已完成。",
    eventId: "session:session:run::completed",
  },
  {
    kind: "failed",
    status: "failed",
    body: "任务运行失败。",
    eventId: "session:session:run::failed",
  },
  {
    kind: "permission",
    status: "needs_input",
    body: "任务正在等待你处理。",
    eventId: "session:session:run:approval:needs_input",
  },
  {
    kind: "AskUser",
    status: "needs_input",
    body: "任务正在等待你处理。",
    eventId: "session:session:run:approval:needs_input",
  },
] as const

describe.each(["external", "pet", "hidden", "minimized", "main"] as const)(
  "session notifications while focus is %s",
  (focus) => {
    it.each(sessionNotices)(
      "delivers $kind with its real event status and a private native body",
      ({ kind, status, body, eventId }) => {
        const flow = permissionFlow(focus)
        flow.trigger(kind)
        flow.trigger(kind)

        expect(flow.delivered).toMatchObject([
          { eventStatus: status, eventId, sessionId: "session" },
        ])
        expect(flow.delivered).toHaveLength(1)
        if (focus === "main") {
          expect(runtime.shown).toEqual([])
          expect(runtime.preferences.notifiedEventIds).toEqual([])
        } else {
          expect(runtime.shown).toEqual([
            { title: status === "needs_input" ? "Vykor 需要处理" : "Vykor", body, silent: true },
          ])
          expect(JSON.stringify(runtime.shown)).not.toContain("SECRET")
          expect(runtime.preferences.notifiedEventIds).toEqual([eventId])
        }
        expect(flow.windowActions).toEqual([])
        expect(flow.rendererMessages).toEqual([])
      }
    )
  }
)

describe("notification clicks return to the originating conversation", () => {
  it.each(sessionNotices)(
    "restores a minimized window for $kind after the selected chat changes",
    ({ kind }) => {
      const flow = permissionFlow("minimized")
      flow.trigger(kind)
      flow.selectSession("another-session")

      expect(runtime.nativeNotifications).toHaveLength(1)
      runtime.nativeNotifications[0]!.emit("click")

      expect(flow.mainState).toEqual({ visible: true, minimized: false, focused: true })
      expect(flow.windowActions).toEqual(["restore", "show", "focus", "send"])
      expect(flow.rendererMessages).toEqual([
        { channel: IpcEvents.trayNotificationClicked, sessionId: "session" },
      ])
    }
  )

  it("shows a hidden conversation window before asking the renderer to select its chat", () => {
    const flow = permissionFlow("hidden")
    flow.ask(undefined, "live", "AskUser")
    flow.selectSession("another-session")

    runtime.nativeNotifications[0]!.emit("click")

    expect(flow.mainState).toEqual({ visible: true, minimized: false, focused: true })
    expect(flow.windowActions).toEqual(["show", "focus", "send"])
    expect(flow.rendererMessages).toEqual([
      { channel: IpcEvents.trayNotificationClicked, sessionId: "session" },
    ])
  })
})

describe.each(["external", "pet", "hidden", "minimized", "main"] as const)(
  "scheduled notifications while focus is %s",
  (focus) => {
    it.each([
      { status: "succeeded", eventStatus: "completed", body: "任务已完成。" },
      { status: "failed", eventStatus: "failed", body: "任务运行失败。" },
      { status: "needs_attention", eventStatus: "needs_input", body: "任务正在等待你处理。" },
    ] as const)(
      "delivers $status with its original chat and respects the window focus",
      ({ status, eventStatus, body }) => {
        const flow = permissionFlow(focus, { scheduled: true })
        flow.scheduled(status)
        flow.scheduled(status)
        flow.selectSession("another-session")

        expect(flow.delivered).toMatchObject([
          { sessionId: "session", eventStatus, eventId: `scheduled:scheduled-run:${eventStatus}` },
        ])
        expect(flow.delivered).toHaveLength(1)
        if (focus === "main") {
          expect(runtime.shown).toEqual([])
          expect(runtime.preferences.notifiedEventIds).toEqual([])
        } else {
          expect(runtime.shown).toEqual([{ title: "Vykor 定时任务", body, silent: true }])
          expect(JSON.stringify(runtime.shown)).not.toContain("SECRET")
          runtime.nativeNotifications[0]!.emit("click")
          expect(flow.mainState).toEqual({ visible: true, minimized: false, focused: true })
          expect(flow.windowActions).toEqual(
            focus === "minimized" ? ["restore", "show", "focus", "send"] : ["show", "focus", "send"]
          )
          expect(flow.rendererMessages).toEqual([
            { channel: IpcEvents.trayNotificationClicked, sessionId: "session" },
          ])
        }
      }
    )
  }
)

describe("scheduled and session notifications have distinct ownership", () => {
  it.each([
    { status: "completed", scheduled: "succeeded", order: "session-first" },
    { status: "failed", scheduled: "failed", order: "session-first" },
    { status: "completed", scheduled: "succeeded", order: "scheduled-first" },
    { status: "failed", scheduled: "failed", order: "scheduled-first" },
  ] as const)(
    "emits one $status result for a scheduled run in $order order",
    ({ status, scheduled, order }) => {
      const flow = permissionFlow("external", { scheduled: true })
      if (order === "session-first") {
        flow.finish(status)
        expect(runtime.shown).toEqual([])
        flow.scheduled(scheduled)
      } else {
        flow.scheduled(scheduled)
        flow.finish(status)
      }
      expect(flow.delivered).toMatchObject([
        { sessionId: "session", eventStatus: status, eventId: `scheduled:scheduled-run:${status}` },
      ])
      expect(flow.delivered).toHaveLength(1)
      expect(runtime.shown).toHaveLength(1)
      expect(runtime.preferences.notifiedEventIds).toEqual([`scheduled:scheduled-run:${status}`])
    }
  )

  it.each([false, true])(
    "immediately alerts for AskUser during a scheduled run (legacy marker: %s)",
    (legacyScheduledTask) => {
      const flow = permissionFlow("pet", { scheduled: true, legacyScheduledTask })
      flow.ask(undefined, "live", "AskUser")
      flow.ask(undefined, "live", "AskUser")

      expect(flow.delivered).toMatchObject([
        {
          sessionId: "session",
          eventStatus: "needs_input",
          eventId: "session:session:run:approval:needs_input",
        },
      ])
      expect(flow.delivered).toHaveLength(1)
      expect(runtime.shown).toEqual([
        { title: "Vykor 需要处理", body: "任务正在等待你处理。", silent: true },
      ])
    }
  )
})

describe("notification preferences apply to every session result", () => {
  it.each(sessionNotices)(
    "honors the disabled $status preference for $kind",
    ({ kind, status }) => {
      runtime.preferences.notificationEvents[status] = false
      permissionFlow("pet").trigger(kind)
      expect(runtime.shown).toEqual([])
      expect(runtime.preferences.notifiedEventIds).toEqual([])
    }
  )

  it.each(sessionNotices)(
    "permits $kind in the main window when notifications are always enabled",
    ({ kind, body }) => {
      runtime.preferences.notificationMode = "always"
      permissionFlow("main").trigger(kind)
      expect(runtime.shown).toHaveLength(1)
      expect(runtime.shown[0]?.body).toBe(body)
    }
  )

  it.each(sessionNotices)(
    "does not deliver historical $kind events as new notifications",
    ({ kind }) => {
      const flow = permissionFlow("external")
      flow.trigger(kind, "catchup")
      expect(flow.delivered).toEqual([])
      expect(runtime.shown).toEqual([])
    }
  )
})

describe("Windows notification activation reaches the original backend request", () => {
  it("routes a native approval button from a real permission activity through the existing IPC", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32")
    const replies: unknown[] = []
    initializeNotificationActions(async () => ({
      sessions: { get: async () => ({ id: "session", status: "active" }) },
      permissions: {
        list: async () => [{ id: "approval", sessionId: "session", status: "pending", toolName: "Shell", payload: {} }],
        reply: async (id: string, input: unknown) => { replies.push({ id, input }); return { status: "approved" } },
      },
    }) as never, () => undefined)
    const flow = permissionFlow("external")
    flow.ask()
    flow.selectSession("another-session")
    await vi.waitFor(() => expect(runtime.shown).toHaveLength(1))
    expect(runtime.shown[0]?.toastXml).toContain('content="允许本次"')
    runtime.activate!({ type: "action", arguments: `type=action&action=0&tag=${runtime.shown[0]!.id}`, actionIndex: 0 })
    await vi.waitFor(() => expect(replies).toEqual([{ id: "approval", input: { status: "approved", decision: "once", clientId: "desktop" } }]))
    vi.restoreAllMocks()
  })

  it("routes a native reply after chat selection changes without duplicating the prompt", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32")
    const prompts: unknown[] = []
    initializeNotificationActions(async () => ({
      sessions: {
        get: async () => ({ id: "session", status: "active" }),
        admitPrompt: async (sessionId: string, input: unknown) => { prompts.push({ sessionId, input }); return {} },
      },
    }) as never, () => undefined)
    const flow = permissionFlow("external")
    flow.finish("completed")
    flow.selectSession("another-session")
    await vi.waitFor(() => expect(runtime.shown).toHaveLength(1))
    expect(runtime.shown[0]?.toastXml).toContain('id="reply"')
    const details: Electron.ActivationArguments = { type: "reply", arguments: `type=reply&tag=${runtime.shown[0]!.id}`, reply: "继续" }
    runtime.activate!(details)
    runtime.activate!(details)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(prompts[0]).toMatchObject({ sessionId: "session", input: { items: [{ type: "text", text: "继续" }], delivery: "queue" } })
    vi.restoreAllMocks()
  })
})
