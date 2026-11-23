import { randomUUID } from "node:crypto"
import { globalShortcut } from "electron"
import type { WebContents } from "electron"
import { COMPUTER_STOP_SHORTCUT } from "../../../shared/computer-types"
import type {
  DesktopComputerActivity,
  DesktopComputerActivityUpdate,
  DesktopComputerAppGrant,
  DesktopComputerCandidate,
  DesktopComputerInteractionEvent,
  DesktopComputerPrompt,
} from "../../../shared/computer-types"
import { IpcEvents } from "../../../shared/ipc-channels"
import { getDesktopPreferences, patchDesktopPreferences } from "../settings/desktop-preferences"

export interface ComputerInteraction {
  isRememberedApp?(id: string): boolean
  authorizeApp(app: DesktopComputerAppGrant, signal: AbortSignal, sessionId?: string, onceOnly?: true): Promise<boolean | "remembered">
  chooseTarget(candidates: readonly DesktopComputerCandidate[], signal: AbortSignal, sessionId?: string, confirmChange?: true): Promise<string | undefined>
  armEmergencyStop?(sessionId: string, runId: string, signal: AbortSignal): boolean
  emergencyStop?(sessionId: string, runId: string): void
  invalidateCapturedImage?(sessionId: string, runId: string): Promise<boolean> | undefined
  publishActivity?(sessionId: string, activity: Omit<DesktopComputerActivity, "sessionId"> | null): void
}

interface PendingPrompt {
  id: string
  choices: ReadonlySet<string>
  canReply?: () => boolean
  resolve(choice?: string): void
}
const pendingPrompts = new WeakMap<WebContents, PendingPrompt>()

function send(owner: WebContents, event: DesktopComputerInteractionEvent): void {
  if (!owner.isDestroyed()) owner.send(IpcEvents.computerInteraction, event)
}

function ask(
  owner: WebContents,
  prompt: DesktopComputerPrompt,
  choices: string[],
  signal: AbortSignal,
  canReply?: () => boolean,
): Promise<string | undefined> {
  if (signal.aborted || owner.isDestroyed() || canReply?.() === false) return Promise.resolve(undefined)
  if (pendingPrompts.has(owner)) throw new Error("已有一个电脑操作正在等待你的选择。")
  return new Promise((resolve, reject) => {
    const asked: PendingPrompt = { id: prompt.id, choices: new Set(choices), canReply, resolve: finish }
    const abort = () => finish()
    function cleanup() {
      signal.removeEventListener("abort", abort)
      if (pendingPrompts.get(owner) === asked) pendingPrompts.delete(owner)
    }
    function finish(choice?: string) {
      cleanup()
      resolve(choice)
      try {
        send(owner, { type: "dismissed", id: prompt.id })
      } catch {
        // WebContents can disappear between the readiness check and send.
      }
    }
    pendingPrompts.set(owner, asked)
    signal.addEventListener("abort", abort, { once: true })
    try {
      send(owner, { type: "prompt", prompt })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export function listComputerAppGrants(): DesktopComputerAppGrant[] {
  return getDesktopPreferences().computerAppGrants ?? []
}

function isRememberedApp(id: string): boolean {
  return listComputerAppGrants().some((grant) => grant.id === id)
}

export function revokeComputerAppGrant(id: string): DesktopComputerAppGrant[] {
  const remaining = listComputerAppGrants().filter((grant) => grant.id !== id)
  patchDesktopPreferences({ computerAppGrants: remaining })
  return remaining
}

/** The owner and operation must both still be live when consuming a reply. */
export function createComputerInteraction(
  owner: WebContents,
  ownerSignal: AbortSignal,
  canReplyInSession?: (sessionId: string) => boolean,
  stopRun?: (sessionId: string, runId: string) => void,
) {
  const replyCheck = (sessionId?: string) =>
    sessionId && canReplyInSession ? () => canReplyInSession(sessionId) : undefined
  const isVisible = (sessionId: string) => !ownerSignal.aborted && !owner.isDestroyed() && (canReplyInSession?.(sessionId) ?? false)
  let activity: DesktopComputerActivity | null = null
  let releaseStop: (() => void) | undefined
  let armedRun: string | undefined
  let emergencyRun: string | undefined

  function emergencyStop(sessionId: string, runId: string): void {
    if (ownerSignal.aborted || emergencyRun === runId || !stopRun) return
    emergencyRun = runId
    stopRun(sessionId, runId)
  }

  function notify(update: DesktopComputerActivityUpdate): void {
    if (!isVisible(update.sessionId)) return
    try {
      owner.send(IpcEvents.computerActivity, update)
    } catch {
      // The page can disappear between checking ownership and sending the update.
    }
  }

  ownerSignal.addEventListener("abort", () => {
    activity = null
    releaseStop?.()
  }, { once: true })

  return {
    isRememberedApp,
    emergencyStop,
    async authorizeApp(app: DesktopComputerAppGrant, operationSignal: AbortSignal, sessionId?: string, onceOnly?: true): Promise<boolean | "remembered"> {
      const signal = AbortSignal.any([ownerSignal, operationSignal])
      if (signal.aborted || replyCheck(sessionId)?.() === false) return false
      if (!onceOnly && isRememberedApp(app.id)) return "remembered"
      const choice = await ask(owner, { id: randomUUID(), kind: "authorize", appName: app.name, ...(onceOnly ? { onceOnly } : {}) },
        onceOnly ? ["once"] : ["once", "always"], signal, replyCheck(sessionId))
      if (signal.aborted) return false
      if (choice === "always") {
        const grants = listComputerAppGrants().filter((grant) => grant.id !== app.id)
        patchDesktopPreferences({ computerAppGrants: [...grants, { id: app.id, name: app.name }] })
        return "remembered"
      }
      return choice === "once"
    },
    async chooseTarget(candidates: readonly DesktopComputerCandidate[], operationSignal: AbortSignal, sessionId?: string, confirmChange?: true) {
      const signal = AbortSignal.any([ownerSignal, operationSignal])
      if (signal.aborted) return undefined
      if (candidates.length <= 1 && !confirmChange) return candidates[0]?.id
      const display = candidates.map(({ id, label, detail }) => ({ id, label, detail }))
      const choice = await ask(owner, { id: randomUUID(), kind: "choose", candidates: display, ...(confirmChange ? { confirmChange } : {}) },
        candidates.map((entry) => entry.id), signal, replyCheck(sessionId))
      return signal.aborted ? undefined : choice
    },
    armEmergencyStop(sessionId: string, runId: string, operationSignal: AbortSignal): boolean {
      const signal = AbortSignal.any([ownerSignal, operationSignal])
      if (!isVisible(sessionId) || signal.aborted || !stopRun) return false
      if (releaseStop && armedRun === runId) return true
      releaseStop?.()
      const release = () => {
        if (releaseStop !== release) return
        releaseStop = undefined
        armedRun = undefined
        signal.removeEventListener("abort", release)
        globalShortcut.unregister(COMPUTER_STOP_SHORTCUT)
      }
      try {
        if (!globalShortcut.register(COMPUTER_STOP_SHORTCUT, () => {
          if (releaseStop === release && !signal.aborted) emergencyStop(sessionId, runId)
        })) return false
      } catch {
        return false
      }
      releaseStop = release
      armedRun = runId
      signal.addEventListener("abort", release, { once: true })
      return true
    },
    publishActivity(sessionId: string, next: Omit<DesktopComputerActivity, "sessionId"> | null): void {
      if (ownerSignal.aborted || (!isVisible(sessionId) && activity?.sessionId !== sessionId)) return
      if (next) {
        if (next.phase === "stopped" && activity && activity.runId !== next.runId) return
        const { preview, ...description } = next
        const showPreview = next.captureEnabled !== false && next.phase !== "paused" && next.phase !== "stopped" &&
          isVisible(sessionId) && isComputerPreview(preview)
        activity = { ...description, sessionId, emergencyArmed: armedRun === next.runId, ...(showPreview ? { preview } : {}) }
      } else if (activity?.sessionId === sessionId) {
        activity = null
      } else return
      notify({ sessionId, activity })
    },
    getActivity(sessionId: string): DesktopComputerActivity | null {
      return isVisible(sessionId) && activity?.sessionId === sessionId ? activity : null
    },
    getBoundActivity(): DesktopComputerActivity | null { return activity },
    clearPreview(): void {
      if (!activity?.preview) return
      const { preview: _preview, ...description } = activity
      activity = description
      notify({ sessionId: activity.sessionId, activity })
    },
  }
}

function isComputerPreview(preview: DesktopComputerActivity["preview"]): preview is NonNullable<DesktopComputerActivity["preview"]> {
  return !!preview && Number.isSafeInteger(preview.width) && Number.isSafeInteger(preview.height) &&
    preview.width > 0 && preview.height > 0 && preview.width <= 3840 && preview.height <= 2160 &&
    preview.dataUrl.length <= 1_400_000 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(preview.dataUrl)
}

export function replyToComputerInteraction(owner: WebContents, input: unknown): boolean {
  const pending = pendingPrompts.get(owner)
  if (!pending || !input || typeof input !== "object" || !("id" in input) || input.id !== pending.id ||
      !("choice" in input) || (input.choice !== null && (typeof input.choice !== "string" || !pending.choices.has(input.choice))))
    return false
  if (pending.canReply && !pending.canReply()) {
    pending.resolve()
    return false
  }
  pending.resolve(input.choice ?? undefined)
  return true
}
