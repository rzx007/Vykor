import { pathToFileURL } from "node:url"
import type { IpcMainInvokeEvent, WebFrameMain } from "electron"
import type { DesktopComputerControl } from "../../../shared/computer-types"
import { IpcChannels } from "../../../shared/ipc-channels"
import type { SendDesktopPromptInput } from "../../../shared/session-types"
import type { AppContext } from "../../core/app-context"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSessionService } from "../session/session-service"
import { createComputerInteraction, listComputerAppGrants, replyToComputerInteraction, revokeComputerAppGrant } from "./interaction"

function documentUrl(value: string): string {
  const url = new URL(value)
  url.hash = ""
  return url.href
}

export function assertComputerSender(ctx: AppContext, event: IpcMainInvokeEvent, frame: WebFrameMain | null): asserts frame is WebFrameMain {
  const main = ctx.windowManager.getMain()
  const source = ctx.paths.rendererUrl ?? pathToFileURL(ctx.paths.indexHtml).href
  if (!frame || !main || main.webContents !== event.sender || event.sender.isDestroyed() ||
    event.sender.mainFrame !== frame || event.senderFrame !== frame ||
    !frame.url || documentUrl(frame.url) !== documentUrl(source)) {
    throw new Error("电脑操作只能从当前 Vykor 主窗口发送。")
  }
}

function parseControl(value: unknown): DesktopComputerControl | undefined {
  if (!value || typeof value !== "object") return
  const { sessionId, runId, action } = value as Partial<DesktopComputerControl>
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 ||
    typeof runId !== "string" || !runId || runId.length > 256) return
  if (action !== "pause" && action !== "resume" && action !== "stop" && action !== "disable_capture" && action !== "enable_capture") return
  return { sessionId, runId, action }
}

export const computerIpcContribution: IpcContribution = {
  id: "computer",
  register(ctx) {
    let owner: { frame: WebFrameMain; signal: AbortSignal; revoke: () => void; interaction: ReturnType<typeof createComputerInteraction> } | undefined
    return [{
      channel: IpcChannels.computerSendPrompt,
      handler(event, input) {
        const frame = event.senderFrame
        if (!frame) throw new Error("电脑操作只能从当前 Vykor 主窗口发送。")
        const authorize = () => {
          assertComputerSender(ctx, event, frame)
          const main = ctx.windowManager.getMain()
          if (main?.isVisible?.() === false || main?.isMinimized?.()) throw new Error("请先恢复电脑操作的主窗口。")
        }
        authorize()
        if (!owner || owner.frame !== frame) {
          owner?.revoke()
          const controller = new AbortController()
          const contents = event.sender
          const main = ctx.windowManager.getMain()
          const interaction = createComputerInteraction(contents, controller.signal,
            (sessionId) => desktopSessionService.subscriptions.getOwnerSessionId(contents.id) === sessionId,
            (sessionId, runId) => { void desktopSessionService.interruptSession({ sessionId, expectedRunId: runId }).catch(() => {}) })
          const invalidateView = (nextSessionId?: string) => {
            desktopSessionService.invalidateComputerView(nextSessionId)
            interaction.clearPreview()
          }
          const hidden = () => invalidateView()
          const removeInvalidation = desktopSessionService.subscriptions.onOwnerInvalidated((id, change) => {
            if (id !== contents.id) return
            if (change?.daemonReset) interaction.clearPreview()
            else invalidateView(change?.nextSessionId)
          })
          const removeSnapshot = desktopSessionService.subscriptions.onOwnerSnapshot((id, view) => {
            const activity = interaction.getBoundActivity()
            if (id !== contents.id || !activity || activity.sessionId !== view.session.id || activity.phase === "stopped") return
            const run = view.runs.find(run => run.id === activity.runId)
            if (view.syncStatus === "reconnecting" || (run && run.status !== "pending" && run.status !== "running")) {
              interaction.clearPreview()
              desktopSessionService.revokeComputerRun(activity.sessionId, activity.runId)
            }
          })
          const revoke = () => {
            contents.removeListener("destroyed", revoke)
            contents.removeListener("render-process-gone", revoke)
            contents.removeListener("did-start-navigation", onNavigation)
            main?.removeListener("hide", hidden)
            main?.removeListener("minimize", hidden)
            main?.removeListener("query-session-end", revoke)
            main?.removeListener("session-end", revoke)
            removeInvalidation()
            removeSnapshot()
            controller.abort()
            owner = undefined
          }
          const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
            if (details.isMainFrame && !details.isSameDocument) revoke()
          }
          contents.once("destroyed", revoke)
          contents.once("render-process-gone", revoke)
          contents.on("did-start-navigation", onNavigation)
          main?.on("hide", hidden)
          main?.on("minimize", hidden)
          main?.once("query-session-end", revoke)
          main?.once("session-end", revoke)
          owner = { frame, signal: controller.signal, revoke, interaction }
        }
        return desktopSessionService.sendComputerPrompt(event.sender, input as SendDesktopPromptInput, authorize, owner.signal, owner.interaction)
      },
    }, {
      channel: IpcChannels.computerReply,
      handler(event, input) {
        assertComputerSender(ctx, event, event.senderFrame)
        return replyToComputerInteraction(event.sender, input)
      },
    }, {
      channel: IpcChannels.computerActivityGet,
      handler(event, sessionId) {
        assertComputerSender(ctx, event, event.senderFrame)
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return null
        return owner?.frame === event.senderFrame ? owner.interaction.getActivity(sessionId) : null
      },
    }, {
      channel: IpcChannels.computerControl,
      handler(event, value) {
        assertComputerSender(ctx, event, event.senderFrame)
        const input = parseControl(value)
        if (!input || owner?.frame !== event.senderFrame || owner.interaction.getActivity(input.sessionId)?.runId !== input.runId)
          return false
        return desktopSessionService.controlComputer(input)
      },
    }, {
      channel: IpcChannels.computerListAppGrants,
      handler(event) {
        assertComputerSender(ctx, event, event.senderFrame)
        return listComputerAppGrants()
      },
    }, {
      channel: IpcChannels.computerRevokeAppGrant,
      handler(event, id) {
        assertComputerSender(ctx, event, event.senderFrame)
        if (typeof id !== "string" || !id.trim() || id.length > 1024) throw new Error("无效的应用标识。")
        const grants = revokeComputerAppGrant(id)
        desktopSessionService.revokeComputerApp(id)
        return grants
      },
    }]
  },
}
