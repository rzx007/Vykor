import { ChevronDown, Goal, Monitor, Plus, ShieldCheck, X, Undo2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"

import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import type { DesktopExecutionState, DesktopSessionActivity } from "@shared/activity-types"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import type {
  DesktopModel,
  DesktopPluginCatalogEntry,
  DesktopPermissionMode,
  DesktopWorkMode,
  DesktopSessionRecord,
} from "@shared/session-types"
import { selectComposerDocumentText, type ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { promptQueueOnlyReason } from "@renderer/stores/desktop-session/pending-prompt-state"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session/store"
import { pluginAppModelContexts } from "../../shell/plugin-apps/plugin-app-model-context"
import { PluginAppComposerContext } from "../../shell/plugin-apps/composer-context"
import { ComposerAttachments } from "./composer-attachments"
import { ComposerBrowserAnnotations } from "./composer-browser-annotations"
import { readComposerDrop } from "./composer-file-input"
import { ComposerSendButton, PermissionModeMenu, permissionModeIcons } from "./controls"
import { ContextUsageControl } from "./context-usage-control"
import { EffortPicker, resolveEffortTiers } from "./effort-picker"
import { ModelPicker } from "./model-picker"
import { RichPromptInput } from "./rich-prompt-input"
import type { ComposerSkill } from "./rich-prompt-input"
import type { ComposerPickerCommand, ComposerPickerItem } from "./composer-picker"
import type { ContextPickerItem } from "./context-picker"
import { isDesktopObservableSession } from "../shared/session-observation"
import { resolvePermissionModeLabel } from "../shared/utils"
import { pluginMentionsEnabled as defaultPluginMentionsEnabled } from "./plugin-mentions-feature"

const observationStatusLabels: Record<DesktopExecutionState, string> = {
  needs_input: "等你处理",
  running: "执行中",
  idle: "空闲",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
}

export function Composer({
  id,
  composerScope,
  imageCanFeedback,
  draft,
  sending,
  running = false,
  interrupting = false,
  models,
  selectedModel,
  selectedProvider,
  modelLabel,
  permissionMode,
  workMode = "execute",
  modeChangePending = false,
  onWorkModeChange,
  effort,
  skills = [],
  plugins = [],
  pluginMentionsEnabled = defaultPluginMentionsEnabled,
  commands = [],
  conversations = [],
  conversationActivities,
  observationEnabled = false,
  activeSessionId = null,
  goalMode = false,
  goalEditing = false,
  onGoalModeChange,
  goalAutoTurns = 0,
  onGoalAutoTurnsChange,
  goalTokenBudget = "",
  onGoalTokenBudgetChange,
  className,
  textareaClassName,
  rows = 2,
  canSubmit,
  contextUsage = null,
  onOpenContextUsage,
  onDraftChange,
  onSubmit,
  computerEnabled = false,
  followUpRunId,
  lastAcceptedInputId,
  onCommand,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
  onSelectEffort,
  attachments = [],
  attachmentPreparation,
  attachmentInteractionEnabled = false,
  attachmentReadOnly = false,
  onPickFiles,
  onDropFiles,
  onPasteFiles,
  onPasteTextAttachment,
  onCancelAttachment,
  onRetryAttachment,
  onRemoveAttachment,
  contextContent,
}: {
  id: string
  composerScope?: string
  imageCanFeedback?: () => boolean
  draft: ComposerDocument
  sending: boolean
  running?: boolean
  interrupting?: boolean
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  permissionMode: DesktopPermissionMode
  workMode?: DesktopWorkMode
  modeChangePending?: boolean
  onWorkModeChange?: (mode: DesktopWorkMode) => void
  effort: string | null
  skills?: readonly ComposerSkill[]
  plugins?: readonly DesktopPluginCatalogEntry[]
  pluginMentionsEnabled?: boolean
  commands?: readonly ComposerPickerItem[]
  conversations?: readonly DesktopSessionRecord[]
  conversationActivities?: Readonly<Record<string, DesktopSessionActivity>>
  observationEnabled?: boolean
  activeSessionId?: string | null
  goalMode?: boolean
  goalEditing?: boolean
  onGoalModeChange?: (active: boolean) => void
  goalAutoTurns?: number
  onGoalAutoTurnsChange?: (count: number) => void
  goalTokenBudget?: string
  onGoalTokenBudgetChange?: (value: string) => void
  className?: string
  textareaClassName?: string
  rows?: number
  canSubmit?: boolean
  contextUsage?: DesktopContextUsageSnapshot | null
  onOpenContextUsage?: () => void | Promise<boolean | void>
  onDraftChange: (value: ComposerDocument) => void
  onSubmit: (delivery?: "queue" | "steer", computer?: true | "auto", appHint?: string) => void
  computerEnabled?: boolean
  followUpRunId?: string
  lastAcceptedInputId?: string
  onCommand?: (command: ComposerPickerCommand) => Promise<void>
  onInterrupt?: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
  onSelectEffort: (effort: string) => void
  attachmentPreparation?: { pending: string[]; error: string | null }
  attachments?: readonly DesktopAttachmentDraft[]
  attachmentInteractionEnabled?: boolean
  attachmentReadOnly?: boolean
  onPickFiles?: () => void | Promise<void>
  onDropFiles?: (files: readonly File[]) => void | Promise<void>
  onPasteFiles?: (files: readonly File[]) => void | Promise<void>
  onPasteTextAttachment?: (text: string) => void | Promise<void>
  onCancelAttachment?: (draftId: string) => void | Promise<void>
  onRetryAttachment?: (draftId: string) => void | Promise<void>
  onRemoveAttachment?: (draftId: string) => void | Promise<void>
  contextContent?: ReactNode
}): React.JSX.Element {
  const browserAnnotations = useDesktopSessionStore(state =>
    composerScope ? state.composerDraftsByScope[composerScope]?.browserAnnotations : undefined
  )
  const preparingAttachments = Boolean(attachmentPreparation?.pending.length)
  const [attachmentActionError, setAttachmentActionError] = useState<string | null>(null)
  const attachmentAction = async (action: () => void | Promise<void>, label: string): Promise<void> => {
    setAttachmentActionError(null)
    try {
      await action()
    } catch {
      setAttachmentActionError(`${label}失败，请重试。正文草稿已保留。`)
    }
  }
  const [activePicker, setActivePicker] = useState<
    "model" | "permission" | "effort" | "goal" | "delivery" | null
  >(null)
  const [contextPickerRequest, setContextPickerRequest] = useState(0)
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  const effortTiers = resolveEffortTiers(models, selectedModel, selectedProvider)
  const executeCommand = async (command: ComposerPickerCommand): Promise<void> => {
    if (command.id === "model") {
      if (models.length === 0) throw new Error("暂无可用模型。")
      setActivePicker("model")
      return
    }
    if (command.id === "effort") {
      if (effortTiers.length === 0) throw new Error("当前模型不支持调整推理强度。")
      setActivePicker("effort")
      return
    }
    if (!onCommand) throw new Error("当前界面不支持该命令。")
    await onCommand(command)
  }
  const permissionLabel = resolvePermissionModeLabel(permissionMode)
  const PermissionIcon = permissionModeIcons[permissionMode]
  const closePicker = (): void => setActivePicker(null)
  const attachDisabled = attachmentReadOnly || sending
  const canObserve = observationEnabled && !goalMode
  const contextItems: ContextPickerItem[] = [
    {
      id: "context:files",
      label: "文件和文件夹",
      description: "添加本地文件或文件夹",
      group: "添加",
      action: { kind: "files" },
    },
    {
      id: "context:goal",
      label: "目标",
      description: "设置要持续追求的目标",
      group: "添加",
      action: { kind: "goal" },
    },
    {
      id: "context:plan",
      label: "计划模式",
      description: "切换为只读分析模式",
      group: "添加",
      action: { kind: "plan" },
    },
    ...conversations
      .filter((session) => session.id !== activeSessionId && session.status !== "archived")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session): ContextPickerItem => {
        const label = session.title.trim() || "未命名对话"
        const activity = conversationActivities?.[session.id]
        const state = activity?.executionState ??
          (session.status === "running" ? "running" : session.status === "error" ? "failed" : "idle")
        return {
          id: `context:conversation:${session.id}`,
          label,
          description: "引用历史对话",
          sourceLabel: "对话",
          group: "历史对话",
          observation: canObserve && isDesktopObservableSession(session) ? {
            priority: state === "needs_input" ? 0 : state === "running" ? 1 : 2,
            workspace: session.cwd,
            status: observationStatusLabels[state],
            updatedAt: activity?.updatedAt ?? session.updatedAt,
          } : undefined,
          action: { kind: "conversation", sessionId: session.id, displayName: label },
        }
      }),
    ...(pluginMentionsEnabled
      ? plugins.map((plugin): ContextPickerItem => ({
          id: `context:plugin:${plugin.pluginId}`,
          label: plugin.displayName,
          description: plugin.description,
          icon: plugin.icon,
          group: "插件",
          action: { kind: "plugin", pluginId: plugin.pluginId, displayName: plugin.displayName },
        }))
      : []),
  ]
  if (canObserve) {
    contextItems.push({
      id: "context:observe-mode",
      label: "观察进度",
      description: "选择要观察的会话",
      group: "添加",
      action: { kind: "observe-mode" },
    })
  }

  const [deliveryChoice, setDeliveryChoice] = useState<{
    delivery: "queue" | "steer"
    runId?: string
    afterInputId?: string
  } | null>(null)
  const appContexts = useSyncExternalStore(
    pluginAppModelContexts.subscribe,
    pluginAppModelContexts.snapshot,
    pluginAppModelContexts.serverSnapshot
  )
  const isFollowUp = Boolean(followUpRunId && !goalMode)
  const fullAccess = permissionMode === "full_access"
  const hasAppContext = appContexts.some(entry => entry.source.sessionId === activeSessionId)
  const canUseComputer = computerEnabled && window.desktop?.computer?.supported === true &&
    workMode === "execute" && !goalMode && !hasAppContext
  const computerScope = composerScope ?? activeSessionId ?? id
  const [armedComputer, setArmedComputer] = useState<{ scope: string; app: string } | null>(null)
  const computerArmed = canUseComputer && armedComputer?.scope === computerScope
  useEffect(() => {
    setArmedComputer((current) => canUseComputer && current?.scope === computerScope ? current : null)
  }, [canUseComputer, computerScope])
  const windowShare = useRef<AbortController | null>(null)
  const [sharingWindow, setSharingWindow] = useState(false)
  useLayoutEffect(() => () => windowShare.current?.abort(), [computerScope])
  if (computerEnabled && window.desktop?.computer?.supported && attachmentInteractionEnabled &&
    onPasteFiles && !attachDisabled && !sharingWindow) {
    contextItems.push({
      id: "context:window-picture",
      label: "分享窗口截图",
      description: "选择一个窗口，发送前可预览",
      group: "添加",
      action: { kind: "window-picture" },
    })
  }
  const shareWindow = async (): Promise<void> => {
    if (!onPasteFiles || attachDisabled || windowShare.current) return
    const controller = new AbortController()
    windowShare.current = controller
    setSharingWindow(true)
    setAttachmentActionError(null)
    try {
      const picture = await window.desktop.computer.shareWindow()
      if (!controller.signal.aborted && picture)
        await onPasteFiles([new File([Uint8Array.from(picture.bytes)], "窗口截图.png", { type: "image/png" })])
    } catch {
      if (!controller.signal.aborted) setAttachmentActionError("无法分享这个窗口，请确认窗口可见并重试。")
    } finally {
      windowShare.current = null
      setSharingWindow(false)
    }
  }
  const hasContent = Boolean(canSubmit || selectComposerDocumentText(draft).trim() ||
    attachments.length || browserAnnotations?.length || hasAppContext)
  const allowSubmit = !preparingAttachments && !sharingWindow && !modeChangePending && (canSubmit ?? hasContent)
  const firstDraftItem = draft.items[0]
  const queueOnlyReason = promptQueueOnlyReason(attachments.length, draft.items, {
    pluginContext: hasAppContext,
    observation: firstDraftItem?.type === "text" && /^\s*observe-session(?:\s|$)/u.test(firstDraftItem.text),
  })
  const manualDelivery = deliveryChoice && deliveryChoice.runId === followUpRunId &&
    deliveryChoice.afterInputId === lastAcceptedInputId ? deliveryChoice.delivery : undefined
  const delivery = queueOnlyReason ? "queue" : fullAccess ? "steer" : manualDelivery ?? "queue"
  const submit = (): void => {
    if (sending || interrupting || !allowSubmit) return
    if (computerArmed) {
      const appHint = armedComputer.app.trim()
      setArmedComputer(null)
      if (appHint) onSubmit("queue", true, appHint)
      else onSubmit("queue", true)
    } else {
      const sendDelivery = isFollowUp ? delivery : undefined
      if (canUseComputer && sendDelivery !== "steer") onSubmit(sendDelivery, "auto")
      else onSubmit(sendDelivery)
    }
  }

  return (
    <form
      className={cn(
        "@container/composer relative min-w-0 overflow-visible rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12",
        className
      )}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if (
          goalEditing &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.currentTarget.contains(event.target as Node) &&
          !sending &&
          !activePicker &&
          !contextPickerOpen
        ) {
          event.preventDefault()
          onGoalModeChange?.(false)
        }
      }}
      onDragOver={(event) => {
        if (!attachmentInteractionEnabled || !event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDrop={(event) => {
        if (!attachmentInteractionEnabled || attachDisabled) return
        const files = readComposerDrop(event.dataTransfer.files)
        if (files.length === 0) return
        event.preventDefault()
        void attachmentAction(() => onDropFiles?.(files), "添加附件")
      }}
    >
      <label htmlFor={id} className="sr-only">
        {goalEditing ? "目标内容" : "输入对话内容"}
      </label>
      {goalEditing ? (
        <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">编辑目标</p>
            <p className="text-xs text-muted-foreground">
              保存后更新目标内容，取消编辑不改变当前目标。
            </p>
          </div>
          <Button
            type="button"
            variant="control"
            size="icon"
            shape="circle"
            aria-label="取消编辑"
            title="取消编辑"
            disabled={sending}
            onClick={() => onGoalModeChange?.(false)}
          >
            <Undo2 />
          </Button>
        </div>
      ) : null}
      {contextContent}
      {composerScope && !goalMode && !goalEditing && browserAnnotations?.length ? (
        <div className="flex px-3 pt-3">
          <ComposerBrowserAnnotations
            key={composerScope}
            annotations={browserAnnotations}
            disabled={sending}
            onUpdateComment={(id, comment) => useDesktopSessionStore.getState().updateBrowserAnnotationComment(composerScope, id, comment)}
            onRemove={id => useDesktopSessionStore.getState().removeBrowserAnnotation(composerScope, id)}
            onClear={() => useDesktopSessionStore.getState().clearBrowserAnnotations(composerScope)}
          />
        </div>
      ) : null}
      {!goalEditing && !goalMode && <PluginAppComposerContext sessionId={activeSessionId} readOnly={sending} />}
      {attachmentActionError || attachmentPreparation?.error ? (
        <p role="alert" className="px-3 pt-2 text-xs text-destructive">
          {attachmentActionError ?? attachmentPreparation?.error}
        </p>
      ) : null}
      <ComposerAttachments
        attachments={attachments}
        composerScope={composerScope}
        imageCanFeedback={imageCanFeedback}
        readOnly={attachmentReadOnly || sending}
        onCancel={(draftId) => void attachmentAction(() => onCancelAttachment?.(draftId), "取消上传")}
        onRetry={(draftId) => void attachmentAction(() => onRetryAttachment?.(draftId), "重试附件")}
        onRemove={(draftId) => void attachmentAction(() => onRemoveAttachment?.(draftId), "移除附件")}
        onShowText={composerScope ? (draftId) => {
          // 恢复正文在 store 中同步完成，上传清理由后台继续处理。
          void attachmentAction(
            () => useDesktopSessionStore.getState().showPastedTextAttachment(composerScope, draftId),
            "显示粘贴文本"
          )
          document.getElementById(id)?.focus()
        } : undefined}
      />
      <RichPromptInput
        key={id}
        id={id}
        value={draft}
        placeholder={
          goalEditing
            ? "编辑目标内容"
            : goalMode
              ? "描述要完成的事情，以及你期望的结果"
              : "随心输入"
        }
        rows={rows}
        disabled={sending}
        skills={skills}
        commands={commands}
        className={textareaClassName}
        onChange={onDraftChange}
        onSubmit={submit}
        onCommand={executeCommand}
        onPasteFiles={attachmentInteractionEnabled && !attachDisabled && onPasteFiles ? (files) => void attachmentAction(() => onPasteFiles(files), "读取附件") : undefined}
        onPasteTextAttachment={
          attachmentInteractionEnabled && !attachDisabled && onPasteTextAttachment ? (text) => void attachmentAction(() => onPasteTextAttachment(text), "添加附件") : undefined
        }
        contextItems={
          onGoalModeChange
            ? contextItems
            : contextItems.filter((item) => item.action.kind !== "goal")
        }
        contextPickerRequest={contextPickerRequest}
        contextPickerOpen={contextPickerOpen}
        onContextPickerOpenChange={setContextPickerOpen}
        onContextAction={(item) => {
          if (item.action.kind === "files" && !attachDisabled) void attachmentAction(() => onPickFiles?.(), "添加附件")
          if (item.action.kind === "window-picture") void shareWindow()
          if (item.action.kind === "plan" && !modeChangePending) onWorkModeChange?.("plan")
          if (item.action.kind === "goal") onGoalModeChange?.(true)
        }}
      />
      <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-1 gap-y-2 px-3 pb-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          aria-label="添加上下文"
          data-context-picker-toggle
          aria-expanded={contextPickerOpen}
          onMouseDown={(event) => event.preventDefault()}
          title="添加上下文"
          disabled={attachDisabled}
          onClick={() => {
            setContextPickerOpen((open) => !open)
            setContextPickerRequest((value) => value + 1)
          }}
        >
          <Plus strokeWidth={1.75} />
        </Button>
        {canUseComputer ? (
          <Button
            type="button"
            variant={computerArmed ? "secondary" : "ghost"}
            size="sm"
            shape="pill"
            aria-label="电脑操作"
            aria-pressed={computerArmed}
            title="让下一条消息使用 Windows 应用"
            disabled={sending || interrupting || modeChangePending}
            onClick={() => setArmedComputer(computerArmed ? null : { scope: computerScope, app: "" })}
          >
            <Monitor className="size-3.5" />
            <span className="@max-[36rem]/composer:sr-only">电脑操作</span>
          </Button>
        ) : null}
        {computerArmed ? (
          <Input
            aria-label="目标应用（可选）"
            placeholder="目标应用（可选）"
            className="w-36"
            maxLength={160}
            value={armedComputer.app}
            onChange={(event) => setArmedComputer({ scope: computerScope, app: event.currentTarget.value })}
          />
        ) : null}
        {goalMode && !goalEditing ? (
          <div className="ml-1 flex h-8 shrink-0 items-center rounded-full bg-secondary">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              disabled={sending}
              aria-label="退出目标输入"
              onClick={() => onGoalModeChange?.(false)}
            >
              <X className="size-3.5" />
            </Button>
            {onGoalAutoTurnsChange || onGoalTokenBudgetChange ? (
              <Popover
                open={activePicker === "goal"}
                onOpenChange={(open) => setActivePicker(open ? "goal" : null)}
              >
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1 rounded-full px-2"
                      disabled={sending}
                      aria-label="目标设置"
                    />
                  }
                >
                  <Goal className="size-3.5" />
                  <span className="@max-[36rem]/composer:sr-only">目标</span>
                  <ChevronDown className="size-3" />
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-64 gap-4 rounded-2xl p-4"
                >
                  <div className="text-sm font-medium">目标设置</div>
                  {onGoalAutoTurnsChange ? (
                    <label className="grid gap-2 text-xs text-muted-foreground">
                      自动续跑轮数
                      <input
                        aria-label="自动续跑额度"
                        type="number"
                        min={1}
                        max={1000}
                        step={1}
                        placeholder="不限"
                        value={goalAutoTurns === 0 ? "" : goalAutoTurns}
                        disabled={sending}
                        onChange={(event) => onGoalAutoTurnsChange(Number(event.target.value))}
                        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </label>
                  ) : null}
                  {onGoalTokenBudgetChange ? (
                    <label className="grid gap-2 text-xs text-muted-foreground">
                      Token 总预算
                      <input
                        aria-label="Token 总预算"
                        type="text"
                        inputMode="numeric"
                        placeholder="不限"
                        value={goalTokenBudget}
                        disabled={sending}
                        onChange={(event) => onGoalTokenBudgetChange(event.target.value)}
                        className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </label>
                  ) : null}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    默认不限，填写后生效。连续停滞时仍会暂停。
                  </p>
                </PopoverContent>
              </Popover>
            ) : (
              <span className="flex items-center gap-1 pr-3 text-xs">
                <Goal className="size-3.5" />
                目标
              </span>
            )}
          </div>
        ) : null}
        <Popover
          open={activePicker === "permission"}
          onOpenChange={(open) => setActivePicker(open ? "permission" : null)}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                shape="pill"
                className={cn(
                  "h-8 max-w-36 min-w-0 shrink-0 overflow-hidden px-2 text-xs font-normal text-muted-foreground @max-[36rem]/composer:gap-1",
                  permissionMode === "full_access" && "text-status-warning hover:text-status-warning aria-expanded:text-status-warning"
                )}
                aria-label={`授权模式：${permissionLabel}`}
                title={`授权模式：${permissionLabel}`}
                disabled={modeChangePending}
              />
            }
          >
            <PermissionIcon data-icon="inline-start" />
            <span className="min-w-0 truncate @max-[36rem]/composer:sr-only">{permissionLabel}</span>
            {permissionMode === "full_access" ? (
              <span aria-hidden="true" className="hidden @max-[36rem]/composer:inline">完全访问</span>
            ) : null}
            <ChevronDown data-icon="inline-end" className="@max-[36rem]/composer:hidden" />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-max max-w-[20rem] min-w-56 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
          >
            <PermissionModeMenu
              selected={permissionMode}
              disabled={modeChangePending}
              onSelect={(mode) => {
                onSelectPermissionMode(mode)
                closePicker()
              }}
            />
          </PopoverContent>
        </Popover>
        {workMode === "plan" ? (
          <div className="ml-1 flex h-8 shrink-0 items-center gap-1 rounded-full bg-secondary pr-3 text-xs">
            <Button type="button" variant="ghost" size="icon-sm" className="rounded-full"
              disabled={sending || modeChangePending} aria-label="退出计划模式" title="当前为计划模式，点击退出"
              onClick={() => onWorkModeChange?.("execute")}>
              <X className="size-3.5" />
            </Button>
            <ShieldCheck className="size-3.5" />
            <span className="@max-[36rem]/composer:sr-only">计划模式</span>
            <span aria-hidden="true" className="hidden @max-[36rem]/composer:inline">计划</span>
          </div>
        ) : null}
        <EffortPicker
          open={activePicker === "effort"}
          onOpenChange={(open) => setActivePicker(open ? "effort" : null)}
          triggerClassName="shrink-0 rounded-full @max-[36rem]/composer:size-8 @max-[36rem]/composer:p-0 @max-[36rem]/composer:[&_[data-slot=effort-label]]:sr-only @max-[36rem]/composer:[&_[data-slot=effort-chevron]]:hidden"
          tiers={effortTiers}
          value={effort}
          onSelect={(nextEffort) => {
            onSelectEffort(nextEffort)
            closePicker()
          }}
        />
        <div className="ml-auto flex min-w-0 max-w-full basis-40 grow shrink-0 items-center justify-end gap-0.5">
          <ModelPicker
            open={activePicker === "model"}
            onOpenChange={(open) => setActivePicker(open ? "model" : null)}
            models={models}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            modelLabel={modelLabel}
            triggerClassName="max-w-52 rounded-full @max-[36rem]/composer:max-w-36"
            onSelectModel={(model) => {
              onSelectModel(model)
              closePicker()
            }}
          />
          <ContextUsageControl snapshot={contextUsage} onOpen={onOpenContextUsage} />
          {isFollowUp && !computerArmed && fullAccess && queueOnlyReason ? (
            <span role="status" className="text-xs text-muted-foreground">{queueOnlyReason}</span>
          ) : null}
          {isFollowUp && !computerArmed && !fullAccess ? (
            <Popover open={activePicker === "delivery"} onOpenChange={(open) => setActivePicker(open ? "delivery" : null)}>
              <PopoverTrigger
                render={<Button type="button" variant="control" shape="pill" size="sm" />}
                disabled={sending || interrupting}
                aria-label="本条消息的发送方式"
                title={queueOnlyReason}
              >
                {delivery === "steer" ? "现在补充" : "排队"}
                <ChevronDown className="size-3" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40 p-1">
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start"
                  disabled={Boolean(queueOnlyReason)}
                  onClick={() => {
                    setDeliveryChoice({ delivery: "steer", runId: followUpRunId, afterInputId: lastAcceptedInputId })
                    closePicker()
                  }}>
                  现在补充
                </Button>
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start"
                  onClick={() => {
                    setDeliveryChoice({ delivery: "queue", runId: followUpRunId, afterInputId: lastAcceptedInputId })
                    closePicker()
                  }}>
                  排队
                </Button>
                {queueOnlyReason ? <p className="px-2 py-1 text-xs text-muted-foreground">{queueOnlyReason}</p> : null}
              </PopoverContent>
            </Popover>
          ) : null}
          {goalEditing ? (
            <Button type="submit" size="sm" shape="pill" disabled={sending || !allowSubmit}>
              {sending ? "正在保存…" : "保存目标"}
            </Button>
          ) : (
            <ComposerSendButton
              sending={sending}
              running={running && !goalMode}
              interrupting={interrupting}
              hasContent={hasContent}
              disabled={!allowSubmit}
              onInterrupt={onInterrupt}
            />
          )}
        </div>
      </div>
    </form>
  )
}
