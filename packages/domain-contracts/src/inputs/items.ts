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
  icon?: string
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


import type { AttachmentIntent } from "../attachments/records.js";
export interface PromptAttachment { assetId: string; intent?: AttachmentIntent; displayName?: string }
