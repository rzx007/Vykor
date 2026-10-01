import type { LucideIcon } from "lucide-react"
import type {
  DesktopCommandCatalogEntry,
  DesktopCommandSource,
  SessionUserInputItem,
} from "@shared/session-types"

export interface ComposerPickerSkill extends Omit<
  Extract<SessionUserInputItem, { type: "skill" }>,
  "type"
> {
  type?: "skill"
  commandName?: string
  source?: "bundled" | "user" | "project" | "plugin"
}

export interface ComposerPickerCatalogSkill extends ComposerPickerSkill {
  displayName: string
  description: string
  sourceLabel: string
}

export interface ComposerPickerCommand {
  id: string
  title: string
  description: string
  requiresEmptyComposer: boolean
  selection: "execute" | "submenu" | "insert"
  icon?: LucideIcon
}

export interface ComposerPickerItem {
  id: string
  kind: "skill" | "command"
  label: string
  description: string
  sourceLabel?: string
  skill?: ComposerPickerSkill
  command?: ComposerPickerCommand
}

export function toComposerSkills(
  commands: readonly DesktopCommandCatalogEntry[]
): ComposerPickerCatalogSkill[] {
  return commands
    .filter(
      (command): command is Extract<DesktopCommandCatalogEntry, { kind: "template" }> =>
        command.kind === "template"
    )
    .map((command) => {
      const name = command.skillName
      return {
        name,
        commandName: command.name.replace(/^\//, ""),
        path: command.path,
        displayName: command.displayName?.trim() || name.replace(/[-_:]+/g, " ") || name,
        description: command.description?.trim() || "使用此技能处理当前请求",
        source: skillSource(command.source),
        sourceLabel: skillSourceLabel(command.source),
      }
    })
    .sort(
      (left, right) =>
        skillSourcePriority(left.source) - skillSourcePriority(right.source) ||
        (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
    )
}

export function filterPickerItems(
  items: readonly ComposerPickerItem[],
  query: string
): ComposerPickerItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  return items.filter(
    (item) =>
      !normalized ||
      [
        item.label,
        item.description,
        item.command?.id ?? "",
        item.skill?.name ?? "",
        item.skill?.commandName ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(normalized))
  )
}

export function pickerItems({
  trigger,
  commands,
  skills,
}: {
  trigger: {
    sigil: "/" | "$" | "@"
    query: string
    mode: "leading" | "inline"
    from?: number
    to?: number
  }
  commands: readonly ComposerPickerItem[]
  skills: readonly ComposerPickerItem[]
}): ComposerPickerItem[] {
  const allowed =
    trigger.sigil === "/" && trigger.mode === "leading"
      ? [...commands.filter((item) => item.command?.requiresEmptyComposer), ...skills]
      : skills
  return filterPickerItems(allowed, trigger.query)
}

function skillSource(source: DesktopCommandSource | undefined): ComposerPickerSkill["source"] {
  return source === "bundled" || source === "user" || source === "project" || source === "plugin"
    ? source
    : undefined
}

function skillSourceLabel(source: DesktopCommandSource | undefined): string {
  if (source === "project") return "项目"
  if (source === "plugin") return "插件"
  if (source === "bundled" || source === "builtin") return "内置"
  return "个人"
}

function skillSourcePriority(source: ComposerPickerSkill["source"]): number {
  if (source === "project") return 0
  if (source === "user") return 1
  if (source === "plugin") return 2
  return 3
}
