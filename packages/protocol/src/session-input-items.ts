export const SESSION_INPUT_LIMITS = {
  maxItems: 256,
  maxSkills: 32,
  maxTextBytes: 1024 * 1024,
  maxNameChars: 128,
  maxDisplayNameChars: 256,
} as const

export type SkillSource = "bundled" | "user" | "project" | "plugin"

/** Safe picker metadata; implementation locations and permissions stay on the server. */
export interface PluginCatalogEntry {
  pluginId: string
  displayName: string
  version: string
  scope: "user" | "managed" | "project" | "local"
  origin: "native" | "converted"
  description: string
  capabilities: ("skills" | "tools" | "agents")[]
}

export type PluginCapabilityRef = {
  type: "capability"
  kind: "plugin"
  pluginId: string
  displayName: string
}

export type PluginAgentRef = {
  type: "capability"
  kind: "plugin_agent"
  pluginId: string
  agentId: string
  displayName: string
}

export type SessionUserInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string; displayName?: string; source?: SkillSource }
  | { type: "mention"; name: string; path: string; displayName?: string }
  | { type: "context"; kind: "conversation"; id: string; displayName: string }
  | PluginCapabilityRef
  | PluginAgentRef

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/
const TEXT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/

export function validateSessionUserInputItems(
  items: readonly SessionUserInputItem[],
): SessionUserInputItem[] {
  if (items.length > SESSION_INPUT_LIMITS.maxItems) throw new Error("item_limit_exceeded")

  let skillCount = 0
  let textBytes = 0
  for (const item of items) {
    if (item.type === "text") {
      assertValidText(item.text)
      textBytes += new TextEncoder().encode(item.text).byteLength
      continue
    }

    if (item.type === "context") {
      if (item.kind !== "conversation") throw new Error("invalid_context_kind")
      assertValidString(item.id, "id")
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.id, SESSION_INPUT_LIMITS.maxNameChars, "id")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
      continue
    }

    if (item.type === "capability") {
      if (item.kind !== "plugin" && item.kind !== "plugin_agent") throw new Error("invalid_capability_kind")
      assertValidString(item.pluginId, "pluginId")
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.pluginId, SESSION_INPUT_LIMITS.maxNameChars, "pluginId")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
      if (item.kind === "plugin_agent") {
        assertValidString(item.agentId, "agentId")
        assertMaximumLength(item.agentId, SESSION_INPUT_LIMITS.maxNameChars, "agentId")
      }
      continue
    }

    assertValidString(item.name, "name")
    assertValidString(item.path, "path")
    assertMaximumLength(item.name, SESSION_INPUT_LIMITS.maxNameChars, "name")
    if (item.displayName !== undefined) {
      assertValidString(item.displayName, "displayName")
      assertMaximumLength(item.displayName, SESSION_INPUT_LIMITS.maxDisplayNameChars, "displayName")
    }
    if (item.type === "skill") {
      skillCount += 1
      if (item.source !== undefined && !isSkillSource(item.source)) throw new Error("invalid_skill_source")
    }
  }

  if (skillCount > SESSION_INPUT_LIMITS.maxSkills) throw new Error("skill_item_limit_exceeded")
  if (textBytes > SESSION_INPUT_LIMITS.maxTextBytes) throw new Error("text_byte_limit_exceeded")
  return [...items]
}

export function normalizeSessionUserInputItems(
  items: readonly SessionUserInputItem[],
): SessionUserInputItem[] {
  const normalized: SessionUserInputItem[] = []
  for (const item of validateSessionUserInputItems(items)) {
    if (item.type !== "text") {
      normalized.push(item)
    } else if (item.text.length > 0) {
      const previous = normalized.at(-1)
      if (previous?.type === "text") previous.text += item.text
      else normalized.push({ type: "text", text: item.text })
    }
  }
  return normalized
}

export function sessionUserInputText(items: readonly SessionUserInputItem[]): string {
  return normalizeSessionUserInputItems(items)
    .map((item) => item.type === "text"
      ? item.text
      : item.type === "context" || item.type === "capability"
        ? `@${item.displayName}`
        : `$${item.name}`)
    .join("")
}

function assertValidString(value: string, field: string): void {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) throw new Error(`invalid_${field}`)
}

function assertValidText(value: string): void {
  if (typeof value !== "string" || TEXT_CONTROL_CHARACTER_PATTERN.test(value)) throw new Error("invalid_text")
}

function assertMaximumLength(value: string, maximum: number, field: string): void {
  if (value.length > maximum) throw new Error(`${field}_limit_exceeded`)
}

function isSkillSource(value: string): value is SkillSource {
  return value === "bundled" || value === "user" || value === "project" || value === "plugin"
}
