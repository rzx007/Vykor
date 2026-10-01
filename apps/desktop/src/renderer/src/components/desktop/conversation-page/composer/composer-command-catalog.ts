import {
  Blocks,
  Brain,
  FileDiff,
  GitBranchPlus,
  Goal,
  Info,
  Minimize2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react"

import type { DesktopCommandCatalogEntry, DesktopPermissionMode } from "@shared/session-types"
import type { ComposerPickerItem } from "./composer-picker-model"

export type ComposerCommandContext = {
  hasSession: boolean
  running: boolean
  canOpenReview: boolean
  pinned: boolean
  permissionMode: DesktopPermissionMode
  hasModels: boolean
  hasEffortTiers: boolean
}

// 服务端命令需要目录确认支持；桌面快捷操作直接复用现有控件和会话接口。
const definitions = [
  {
    id: "new",
    title: "新聊天",
    description: "沿用当前配置，开始空白聊天",
    icon: Plus,
    local: true,
  },
  {
    id: "model",
    title: "切换模型",
    description: "选择模型和服务商",
    icon: SlidersHorizontal,
    local: true,
  },
  { id: "effort", title: "推理强度", description: "调整模型的思考强度", icon: Brain, local: true },
  { id: "status", title: "状态", description: "查看聊天状态和当前模型", icon: Info, local: false },
  { id: "goal", title: "目标", description: "设置需要持续完成的目标", icon: Goal, local: false },
  {
    id: "plan",
    title: "计划模式",
    description: "切换为只读分析和规划",
    icon: ShieldCheck,
    local: true,
  },
  {
    id: "diff",
    title: "查看变更",
    description: "审阅工作区未提交的改动",
    icon: FileDiff,
    local: true,
  },
  {
    id: "compact",
    title: "压缩上下文",
    description: "压缩聊天记录，节省上下文空间",
    icon: Minimize2,
    local: false,
  },
  {
    id: "fork",
    title: "创建聊天分支",
    description: "保留历史，在新聊天中继续",
    icon: GitBranchPlus,
    local: true,
  },
  { id: "pin", title: "置顶聊天", description: "将当前聊天保留在侧边栏", icon: Pin, local: true },
  { id: "rename", title: "重命名", description: "修改当前聊天的名称", icon: Pencil, local: true },
  {
    id: "skills",
    title: "技能与插件",
    description: "管理技能、MCP 和插件",
    icon: Blocks,
    local: false,
  },
]

export function toComposerCommands(
  catalog: readonly DesktopCommandCatalogEntry[],
  context: ComposerCommandContext
): ComposerPickerItem[] {
  const supported = new Set(
    catalog
      .filter(
        (entry) =>
          entry.kind === "session" &&
          entry.selection === "execute" &&
          entry.requiresEmptyComposer === true
      )
      .map((entry) => entry.name.replace(/^\//, "").trim())
  )

  return definitions
    .filter((command) => {
      if (!command.local && !supported.has(command.id)) return false
      switch (command.id) {
        case "new":
        case "pin":
        case "rename":
          return context.hasSession
        case "compact":
        case "fork":
          return context.hasSession && !context.running
        case "diff":
          return context.canOpenReview
        case "model":
          return context.hasModels
        case "effort":
          return context.hasEffortTiers
        default:
          return true
      }
    })
    .map((definition) => {
      const { id } = definition
      const presentation =
        id === "pin" && context.pinned
          ? { title: "取消置顶", description: "将当前聊天移出置顶列表", icon: PinOff }
          : id === "plan" && context.permissionMode === "plan"
            ? { title: "退出计划模式", description: "恢复手动批准操作", icon: ShieldCheck }
            : definition
      return {
        id,
        kind: "command",
        label: presentation.title,
        description: presentation.description,
        sourceLabel: `/${id}`,
        command: {
          id,
          title: presentation.title,
          description: presentation.description,
          icon: presentation.icon,
          requiresEmptyComposer: true,
          selection: "execute",
        },
      }
    })
}
