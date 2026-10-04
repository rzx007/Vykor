import {
  Bot,
  FileText,
  Folder,
  Globe2,
  MessageCirclePlus,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"

import type { FileViewerTab } from "@renderer/components/desktop/tools/file-viewer"

export type UtilityTool = "review" | "terminal" | "browser" | "files" | "side-chat" | "agents"

export type UtilityToolRequest = Extract<UtilityTool, "terminal" | "files" | "browser" | "agents" | "side-chat">

export type UtilityTab = {
  id: string
  tool: UtilityTool
  title: string
  filePath?: string
  fileIcon?: LucideIcon
  fileType?: FileViewerTab["type"]
  projectPath?: string
  terminalId?: string
}

export const utilityToolMeta: Record<
  UtilityTool,
  { icon: LucideIcon; label: string; shortcut?: string }
> = {
  review: { icon: FileText, label: "审阅", shortcut: "Ctrl+Shift+G" },
  terminal: { icon: SquareTerminal, label: "终端", shortcut: "Ctrl+`" },
  browser: { icon: Globe2, label: "浏览器", shortcut: "Ctrl+T" },
  files: { icon: Folder, label: "文件", shortcut: "Ctrl+P" },
  "side-chat": { icon: MessageCirclePlus, label: "侧边聊天", shortcut: "Ctrl+Alt+S" },
  agents: { icon: Bot, label: "子智能体" },
}

export const utilityToolOrder: UtilityTool[] = [
  "agents",
  "review",
  "terminal",
  "browser",
  "files",
  "side-chat",
]
