import { pathToFileURL } from "node:url"
import type { IpcMainInvokeEvent, WebFrameMain } from "electron"
import { readRuntimeMetadata } from "@vykor/protocol"
import type { DesktopComputerControl, DesktopComputerSettings } from "../../../shared/computer-types"
import { IpcChannels } from "../../../shared/ipc-channels"
import type { AppContext } from "../../core/app-context"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSessionService } from "../session/session-service"
import { patchDesktopPreferences } from "../settings/desktop-preferences"
import { computerAvailability, computerDriverAvailability, computerPlatformAvailability, computerSettingsPolicy } from "./availability"
import { createComputerInteraction, listComputerAppGrants, replyToComputerInteraction, revokeComputerAppGrant } from "./interaction"
import { shareWindowsPicture } from "./window-share"

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

type ComputerOwner = {
  frame: WebFrameMain
  signal: AbortSignal
  revoke(): void
  interaction: ReturnType<typeof createComputerInteraction>
}

const owners = new WeakMap<AppContext, ComputerOwner>()

/** Native app access is optional on the ordinary prompt and belongs to the current main document. */
export function computerPromptOwner(ctx: AppContext, event: IpcMainInvokeEvent, sessionId: string) {
  const frame = event.senderFrame
  if (!frame || computerPlatformAvailability() !== "enabled") return
  const session = desktopSessionService.subscriptions.getOwnerSessionRecord(event.sender.id)
  if (session?.id !== sessionId || session.parentId !== undefined || session.status === "archived" || session.status === "closing") return
  const runtime = readRuntimeMetadata(session.metadata)
  if (runtime.workMode === "plan" || runtime.permissionMode === "plan") return
  const authorize = () => {
    assertComputerSender(ctx, event, frame)
    if (computerPlatformAvailability() !== "enabled") throw new Error("电脑控制已停用。")
    const main = ctx.windowManager.getMain()
    if (main?.isVisible() === false || main?.isMinimized()) throw new Error("请先恢复电脑操作的主窗口。")
  }
  try {
    authorize()
  } catch {
    return
  }
  let owner = owners.get(ctx)
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
      owners.delete(ctx)
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
    owners.set(ctx, owner)
  }
  return { ...owner, authorize }
}

export const computerIpcContribution: IpcContribution = {
  id: "computer",
  register(ctx) {
    let windowShare: AbortController | undefined
    let updatingSettings = false
    let inputRelease: DesktopComputerSettings["inputRelease"]
    let releasingInput: Promise<void> | undefined

    const readSettings = async (): Promise<DesktopComputerSettings> => {
      const availability = await computerAvailability()
      await releasingInput
      const settings = computerSettingsPolicy()
      return {
        ...settings,
        availability: settings.locked === "unsupported" ? "unsupported" : settings.enabled ? availability : "disabled",
        inputRelease,
      }
    }

    return [{
      channel: IpcChannels.computerAvailability,
      async handler(event) {
        assertComputerSender(ctx, event, event.senderFrame)
        return computerAvailability()
      },
    }, {
      channel: IpcChannels.computerSettingsGet,
      async handler(event) {
        assertComputerSender(ctx, event, event.senderFrame)
        return readSettings()
      },
    }, {
      channel: IpcChannels.computerSettingsUpdate,
      async handler(event, update) {
        const frame = event.senderFrame
        assertComputerSender(ctx, event, frame)
        if (!update || typeof update !== "object" || !("setting" in update) || !("value" in update))
          throw new Error("无效的电脑控制设置。")
        const { setting, value } = update
        if (typeof value !== "boolean" || (setting !== "enabled" && setting !== "alwaysForeground"))
          throw new Error("无效的电脑控制设置。")
        if (updatingSettings) throw new Error("正在更新电脑控制设置，请稍后再试。")
        const settings = computerSettingsPolicy()
        if (settings.locked) throw new Error("当前启动配置或平台不支持修改电脑控制设置。")
        updatingSettings = true
        try {
          if (setting === "alwaysForeground") {
            if (!settings.enabled) throw new Error("请先启用电脑控制。")
            patchDesktopPreferences({ computerAlwaysForeground: value })
          } else if (value) {
            if (inputRelease === "unconfirmed") throw new Error("无法确认键鼠已释放。请重启 Vykor 后再启用。")
            const availability = await computerDriverAvailability()
            if (availability !== "ready") throw new Error("驱动不可用。请重新安装经过核验的版本后再启用。")
            assertComputerSender(ctx, event, frame)
            patchDesktopPreferences({ computerEnabled: true })
            return { ...computerSettingsPolicy(), availability }
          } else {
            patchDesktopPreferences({ computerEnabled: false })
            windowShare?.abort()
            owners.get(ctx)?.interaction.clearPreview()
            releasingInput = desktopSessionService.disconnectComputer().catch(() => false).then(released => {
              inputRelease = released ? undefined : "unconfirmed"
            })
            await releasingInput
            releasingInput = undefined
          }
          return await readSettings()
        } finally {
          updatingSettings = false
        }
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
        const owner = owners.get(ctx)
        return owner?.frame === event.senderFrame ? owner.interaction.getActivity(sessionId) : null
      },
    }, {
      channel: IpcChannels.computerShareWindow,
      async handler(event) {
        const frame = event.senderFrame
        assertComputerSender(ctx, event, frame)
        const main = ctx.windowManager.getMain()
        if (!main?.isVisible() || main.isMinimized())
          throw new Error("请在支持电脑操作的 Windows 主窗口里分享截图。")
        if (windowShare) return null
        const controller = new AbortController()
        windowShare = controller
        const contents = event.sender
        const abort = (): void => controller.abort()
        const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
          if (details.isMainFrame && !details.isSameDocument) abort()
        }
        contents.once("destroyed", abort)
        contents.once("render-process-gone", abort)
        contents.on("did-start-navigation", navigate)
        main.once("hide", abort)
        main.once("minimize", abort)
        const removeInvalidation = desktopSessionService.subscriptions.onOwnerInvalidated((id) => {
          if (id === contents.id) abort()
        })
        try {
          if (await computerAvailability(controller.signal) !== "ready")
            throw new Error("电脑操作驱动不可用。")
          assertComputerSender(ctx, event, frame)
          const picture = await shareWindowsPicture(main, controller.signal)
          assertComputerSender(ctx, event, frame)
          return controller.signal.aborted ? null : picture
        } catch (error) {
          if (controller.signal.aborted) return null
          throw error
        } finally {
          windowShare = undefined
          contents.removeListener("destroyed", abort)
          contents.removeListener("render-process-gone", abort)
          contents.removeListener("did-start-navigation", navigate)
          main.removeListener("hide", abort)
          main.removeListener("minimize", abort)
          removeInvalidation()
        }
      },
    }, {
      channel: IpcChannels.computerControl,
      handler(event, value) {
        assertComputerSender(ctx, event, event.senderFrame)
        const input = parseControl(value)
        const owner = owners.get(ctx)
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
