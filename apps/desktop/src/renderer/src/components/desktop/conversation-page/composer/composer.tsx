import { ChevronDown, Goal, Mic, ShieldCheck, X, Undo2 } from "lucide-react"
import { IconPlus } from "@tabler/icons-react"
import { useState, type ReactNode } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import type {
  DesktopModel,
  DesktopPluginCatalogEntry,
  DesktopPermissionMode,
  DesktopWorkMode,
  DesktopSessionRecord,
} from "@shared/session-types"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { PluginAppComposerContext } from "../../shell/plugin-apps/composer-context"
import { ComposerAttachments } from "./composer-attachments"
import { readComposerDrop } from "./composer-file-input"
import { ComposerIconButton, ComposerSendButton, PermissionModeMenu, permissionModeIcons } from "./controls"
import { ContextUsageControl } from "./context-usage-control"
import { EffortPicker, resolveEffortTiers } from "./effort-picker"
import { ModelPicker } from "./model-picker"
import { RichPromptInput } from "./rich-prompt-input"
import type { ComposerSkill } from "./rich-prompt-input"
import type { ComposerPickerCommand, ComposerPickerItem } from "./composer-picker"
import type { ContextPickerItem } from "./context-picker"
import { resolvePermissionModeLabel } from "../shared/utils"
import { pluginMentionsEnabled as defaultPluginMentionsEnabled } from "./plugin-mentions-feature"

export function Composer({
  id,
  draft,
  sending,
  running = false,
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
  onCommand,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
  onSelectEffort,
  attachments = [],
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
  draft: ComposerDocument
  sending: boolean
  running?: boolean
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
  onOpenContextUsage?: () => void
  onDraftChange: (value: ComposerDocument) => void
  onSubmit: () => void
  onCommand?: (command: ComposerPickerCommand) => Promise<void>
  onInterrupt?: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
  onSelectEffort: (effort: string) => void
  attachments?: readonly DesktopAttachmentDraft[]
  attachmentInteractionEnabled?: boolean
  attachmentReadOnly?: boolean
  onPickFiles?: () => void
  onDropFiles?: (files: readonly File[]) => void
  onPasteFiles?: (files: readonly File[]) => void
  onPasteTextAttachment?: (text: string) => void
  onCancelAttachment?: (draftId: string) => void
  onRetryAttachment?: (draftId: string) => void
  onRemoveAttachment?: (draftId: string) => void
  contextContent?: ReactNode
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<
    "model" | "permission" | "effort" | "goal" | null
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
  const allowSubmit = !modeChangePending && (canSubmit ?? draft.items.length > 0)
  const attachDisabled = attachmentReadOnly || sending
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
      .map((session): ContextPickerItem => ({
        id: `context:conversation:${session.id}`,
        label: session.title.trim() || "未命名对话",
        description: "引用历史对话",
        sourceLabel: "对话",
        group: "历史对话",
        action: {
          kind: "conversation",
          sessionId: session.id,
          displayName: session.title.trim() || "未命名对话",
        },
      })),
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

  const submit = (): void => {
    if (sending || !allowSubmit) return
    onSubmit()
  }

  return (
    <form
      className={cn(
        "relative min-w-0 overflow-visible rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12",
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
        if (!attachmentInteractionEnabled || sending) return
        const files = readComposerDrop(event.dataTransfer.files)
        if (files.length === 0) return
        event.preventDefault()
        onDropFiles?.(files)
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
      {!goalEditing && !goalMode && <PluginAppComposerContext sessionId={activeSessionId} readOnly={sending} />}
      <ComposerAttachments
        attachments={attachments}
        readOnly={attachmentReadOnly || sending}
        onCancel={(draftId) => onCancelAttachment?.(draftId)}
        onRetry={(draftId) => onRetryAttachment?.(draftId)}
        onRemove={(draftId) => onRemoveAttachment?.(draftId)}
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
        onPasteFiles={attachmentInteractionEnabled && !sending ? onPasteFiles : undefined}
        onPasteTextAttachment={
          attachmentInteractionEnabled && !sending ? onPasteTextAttachment : undefined
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
          if (item.action.kind === "files") onPickFiles?.()
          if (item.action.kind === "plan" && !modeChangePending) onWorkModeChange?.("plan")
          if (item.action.kind === "goal") onGoalModeChange?.(true)
        }}
      />
      <div className="flex h-12 min-w-0 items-center gap-1 px-3 pb-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="rounded-full"
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
          <IconPlus className="size-5" />
        </Button>
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
                  目标
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
                  "ml-1 h-8 max-w-36 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground",
                  permissionMode === "full_access" && "text-status-warning hover:text-status-warning aria-expanded:text-status-warning"
                )}
                disabled={modeChangePending}
              />
            }
          >
            <PermissionIcon data-icon="inline-start" />
            <span className="min-w-0 truncate">{permissionLabel}</span>
            <ChevronDown data-icon="inline-end" />
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
              disabled={sending || modeChangePending} aria-label="退出计划模式"
              onClick={() => onWorkModeChange?.("execute")}>
              <X className="size-3.5" />
            </Button>
            <ShieldCheck className="size-3.5" />
            计划模式
          </div>
        ) : null}
        <EffortPicker
          open={activePicker === "effort"}
          onOpenChange={(open) => setActivePicker(open ? "effort" : null)}
          tiers={effortTiers}
          value={effort}
          onSelect={(nextEffort) => {
            onSelectEffort(nextEffort)
            closePicker()
          }}
        />
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          <ModelPicker
            open={activePicker === "model"}
            onOpenChange={(open) => setActivePicker(open ? "model" : null)}
            models={models}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            modelLabel={modelLabel}
            onSelectModel={(model) => {
              onSelectModel(model)
              closePicker()
            }}
          />
          <ComposerIconButton label="语音输入">
            <Mic />
          </ComposerIconButton>
          <ContextUsageControl snapshot={contextUsage} onOpen={onOpenContextUsage} />
          {goalEditing ? (
            <Button type="submit" size="sm" shape="pill" disabled={sending || !allowSubmit}>
              {sending ? "正在保存…" : "保存目标"}
            </Button>
          ) : (
            <ComposerSendButton
              sending={sending}
              running={running && !goalMode}
              disabled={!allowSubmit}
              onInterrupt={onInterrupt}
            />
          )}
        </div>
      </div>
    </form>
  )
}
