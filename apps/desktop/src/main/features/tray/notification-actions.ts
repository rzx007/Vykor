import { randomBytes, randomUUID } from "node:crypto"
import { Notification } from "electron"
import { parseGoalActionInput, type VykorClient } from "@vykor/application-client"
import type { TrayNotificationOptions } from "../../../shared/ipc-channels"
import { getDesktopPreferences, patchDesktopPreferences } from "../settings/desktop-preferences"
import type { DesktopNotificationTarget } from "../settings/desktop-preferences-storage"

let getClient: (() => Promise<VykorClient>) | undefined
let openSession: ((sessionId: string) => void) | undefined
const inFlight = new Set<string>()

export function initializeNotificationActions(
  client: () => Promise<VykorClient>,
  navigate: (sessionId: string) => void
): void {
  getClient = client
  openSession = navigate
  if (process.platform === "win32") {
    Notification.handleActivation((details) => {
      void handleNotificationActivation(details)
    })
    for (const target of getDesktopPreferences().notificationTargets ?? []) {
      if (target.reply && !target.resolved)
        showResult(target, "上次回复尚未确认，可重试或点击打开原对话。")
    }
  }
}

/** Undefined keeps ordinary notifications on their existing synchronous delivery path. */
export function notificationInteractionOptions(
  options: TrayNotificationOptions,
  body: string
): Promise<Electron.NotificationConstructorOptions> | undefined {
  if (process.platform !== "win32" || !getClient || !options.sessionId) return undefined
  const target: DesktopNotificationTarget = {
    id: randomBytes(8).toString("hex"),
    sessionId: options.sessionId,
    kind: options.permissionId ? "open" : "reply",
    ...(options.permissionId ? { permissionId: options.permissionId } : {}),
  }
  return (async () => {
    if (target.permissionId) {
      try {
        const request = await pendingPermission(await getClient!(), target)
        const review = request?.payload.approvalReview
        if (
          request &&
          !(
            review &&
            typeof review === "object" &&
            "status" in review &&
            review.status === "reviewing"
          )
        ) {
          target.kind = request.toolName === "AskUser" ? "question" : "approval"
        }
      } catch {
        // Offline requests remain openable; approval requires the authoritative record.
      }
    } else if (options.eventStatus === "needs_input") {
      target.kind = "open"
      try {
        const goal = await (await getClient!()).sessions.getGoal(target.sessionId)
        if (!goal && !options.attentionId?.startsWith("goal:")) target.kind = "reply"
        else if (
          goal?.status === "waiting_user" &&
          goal.wait?.kind === "user" &&
          goal.objectiveVersion === goal.wait.objectiveVersion &&
          options.attentionId === `goal:${goal.id}:question:${goal.wait.questionId}`
        ) {
          target.kind = "goal"
          target.goalId = goal.id
          target.objectiveVersion = goal.objectiveVersion
          target.questionId = goal.wait.questionId
        }
      } catch {
        // A stale or unavailable goal cannot safely become an ordinary prompt.
      }
    }
    saveTarget(target)
    return { id: target.id, toastXml: notificationXml(target, options.title, body, options.silent) }
  })()
}

function saveTarget(target: DesktopNotificationTarget): void {
  const targets = getDesktopPreferences().notificationTargets ?? []
  patchDesktopPreferences({
    notificationTargets: [...targets.filter((item) => item.id !== target.id), target].slice(-1000),
  })
}

async function pendingPermission(client: VykorClient, target: DesktopNotificationTarget) {
  const requests = await client.permissions.list({ sessionId: target.sessionId, status: "pending" })
  return requests.find(
    (request) =>
      request.id === target.permissionId &&
      request.status === "pending" &&
      (request.sessionId === target.sessionId ||
        request.payload.childSessionId === target.sessionId)
  )
}

export async function handleNotificationActivation(
  details: Electron.ActivationArguments
): Promise<void> {
  const args = new URLSearchParams(details.arguments)
  const id = args.get("tag")
  const target = (getDesktopPreferences().notificationTargets ?? []).find((item) => item.id === id)
  if (!target || !getClient) return
  const action = args.get("action")
  const actionIndex = details.actionIndex ?? (action === null ? -1 : Number(action))
  if (details.type === "click" || (details.type === "action" && actionIndex === 2)) {
    openSession?.(target.sessionId)
    return
  }
  if (target.resolved || inFlight.has(target.id)) return
  if (details.type === "reply" && !["reply", "question", "goal"].includes(target.kind)) return
  if (details.type === "action" && (target.kind !== "approval" || ![0, 1].includes(actionIndex)))
    return
  if (details.type !== "reply" && details.type !== "action") return
  const text = details.reply ?? details.userInputs?.reply
  if (details.type === "reply" && (typeof text !== "string" || !text.trim())) return

  inFlight.add(target.id)
  try {
    if (details.type === "reply") {
      if (!target.reply || target.reply.text !== text)
        target.reply = { id: randomUUID(), text: text! }
      // Persist before connecting so an offline reply is recoverable too.
      saveTarget(target)
    }
    const client = await getClient()
    const session = await client.sessions.get(target.sessionId)
    if (session.status === "archived") throw new Error("Session archived")
    if (details.type === "reply" && target.kind === "reply") {
      await client.sessions.admitPrompt(target.sessionId, {
        id: target.reply!.id,
        items: [{ type: "text", text: target.reply!.text }],
        attachments: [],
        delivery: "queue",
        metadata: {
          origin: { client: "desktop", component: "notification", action: "append_prompt" },
        },
      })
    } else if (target.kind === "goal") {
      if (target.reply!.expectedRevision === undefined) {
        const goal = await client.sessions.getGoal(target.sessionId)
        if (
          !goal ||
          goal.id !== target.goalId ||
          goal.objectiveVersion !== target.objectiveVersion ||
          goal.status !== "waiting_user" ||
          goal.wait?.kind !== "user" ||
          goal.wait.questionId !== target.questionId ||
          goal.wait.objectiveVersion !== target.objectiveVersion
        ) {
          target.resolved = true
          delete target.reply
          saveTarget(target)
          showResult(target, "该问题已处理或已过期，点击查看当前对话。")
          return
        }
        target.reply!.expectedRevision = goal.revision
        saveTarget(target)
      }
      // Retry the same accepted action before judging the goal's newer state.
      const result = await client.sessions.applyGoalAction(
        target.sessionId,
        target.goalId!,
        parseGoalActionInput({
          requestId: target.reply!.id,
          expectedRevision: target.reply!.expectedRevision,
          action: "resume",
          questionId: target.questionId,
          objectiveVersion: target.objectiveVersion,
          response: target.reply!.text,
        })
      )
      if (
        result.id !== target.goalId ||
        result.objectiveVersion !== target.objectiveVersion ||
        (result.status !== "active" && result.queuedResume?.requestId !== target.reply!.id)
      )
        throw new Error("Goal answer was not accepted")
    } else {
      const request = await pendingPermission(client, target)
      if (!request || (target.kind === "approval" && request.toolName === "AskUser")) {
        target.resolved = true
        delete target.reply
        saveTarget(target)
        showResult(target, "该请求已处理或已过期，点击查看当前对话。")
        return
      }
      const status = details.type === "reply" || actionIndex === 0 ? "approved" : "denied"
      const result = await client.permissions.reply(request.id, {
        status,
        decision: "once",
        clientId: "desktop",
        ...(details.type === "reply" ? { answer: text } : {}),
      })
      if (result.status !== status) {
        target.resolved = true
        delete target.reply
        saveTarget(target)
        showResult(target, "该请求已过期，未执行授权。点击查看当前对话。")
        return
      }
    }
    target.resolved = true
    delete target.reply
    saveTarget(target)
    showResult(
      target,
      details.type === "reply"
        ? "回复已发送。"
        : actionIndex === 0
          ? "已允许本次操作。"
          : "已拒绝本次操作。"
    )
  } catch {
    showResult(
      target,
      details.type === "reply"
        ? "回复未发送。可在通知中重试，或点击打开原对话。"
        : "授权未提交，请点击打开原对话后重试。"
    )
  } finally {
    inFlight.delete(target.id)
  }
}

function showResult(target: DesktopNotificationTarget, body: string): void {
  try {
    new Notification({
      id: target.id,
      title: "Vykor",
      body,
      silent: true,
      toastXml: notificationXml(target, "Vykor", body, true),
    }).show()
  } catch {
    console.warn("[tray] notification action result could not be displayed")
  }
}

function notificationXml(
  target: DesktopNotificationTarget,
  title: string,
  body: string,
  silent?: boolean
): string {
  const args = (type: string, action?: number): string =>
    escapeXml(`type=${type}&${action === undefined ? "" : `action=${action}&`}tag=${target.id}`)
  const reply = !target.resolved && ["reply", "question", "goal"].includes(target.kind)
  const approval = !target.resolved && target.kind === "approval"
  return (
    `<toast launch="${args("action", 2)}"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual>` +
    (reply
      ? `<actions><input id="reply" type="text" placeHolderContent="回复此对话"${target.reply ? ` defaultInput="${escapeXml(target.reply.text)}"` : ""}/><action content="回复" arguments="${args("reply")}" hint-inputId="reply" activationType="foreground"/></actions>`
      : approval
        ? `<actions><action content="允许本次" arguments="${args("action", 0)}" activationType="foreground"/><action content="拒绝" arguments="${args("action", 1)}" activationType="foreground"/></actions>`
        : "") +
    (silent ? '<audio silent="true"/>' : "") +
    "</toast>"
  )
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!
  )
}
