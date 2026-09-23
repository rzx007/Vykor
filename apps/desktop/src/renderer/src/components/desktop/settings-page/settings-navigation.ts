import {
  BrainCircuit,
  CircleUserRound,
  Code2,
  CreditCard,
  GitBranch,
  HardDrive,
  Keyboard,
  Link2,
  Palette,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react"

export type SettingsNavigationItem = {
  label: string
  slug: string
  icon: typeof Settings2
}

export const personalSettingsNavigation: SettingsNavigationItem[] = [
  { label: "常规", slug: "general", icon: Settings2 },
  { label: "个人资料", slug: "profile", icon: CircleUserRound },
  { label: "外观", slug: "appearance", icon: Palette },
  { label: "供应商", slug: "providers", icon: BrainCircuit },
  { label: "权限", slug: "permissions", icon: ShieldCheck },
  { label: "个性化", slug: "personalization", icon: Sparkles },
  { label: "键盘快捷键", slug: "keyboard", icon: Keyboard },
  { label: "使用情况和计费", slug: "billing", icon: CreditCard },
]

export const integrationSettingsNavigation: SettingsNavigationItem[] = [
  { label: "连接", slug: "connections", icon: Link2 },
]

export const codingSettingsNavigation: SettingsNavigationItem[] = [
  { label: "终端", slug: "terminal", icon: TerminalSquare },
  { label: "Git", slug: "git", icon: GitBranch },
  { label: "运行环境", slug: "runtime", icon: Code2 },
  { label: "存储", slug: "storage", icon: HardDrive },
]

const settingsNavigation = [
  ...personalSettingsNavigation,
  ...integrationSettingsNavigation,
  ...codingSettingsNavigation,
]

export const defaultSettingsSection = "general"

export function settingsSectionLabel(slug: string | undefined): string {
  return settingsNavigation.find((item) => item.slug === slug)?.label ?? "常规"
}

export function isSettingsSection(slug: string | undefined): boolean {
  return settingsNavigation.some((item) => item.slug === slug)
}

export function settingsSectionSlug(label: string): string {
  return settingsNavigation.find((item) => item.label === label)?.slug ?? defaultSettingsSection
}
