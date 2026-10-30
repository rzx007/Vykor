/** 产品业务类型；会话与同步类型由公开 SDK 维护。 */
import type { MemoryEntryRecord, PluginAppConversationRequest } from "@vykor/protocol";
import type { AdmitClientPromptInput as CoreAdmitClientPromptInput } from "@rzx/client";
import type { PluginInfo } from "./extension-types.js";
export type * from "@rzx/client";
export type { SessionStateSnapshot } from "@vykor/protocol";
export type * from "./extension-types.js";
export type * from "./attachment-types.js";
export type { MemoryEntryRecord, MemoryRevision, UpdateMemoryEntryInput, ClearMemoryInput, ClearSessionWorktreeBindingInput, CreateScheduledTaskInput, ScheduledRunRecord, ScheduledTaskRecord, UpdateScheduledTaskInput, CreateNoteInput, NoteRecord, UpdateNoteInput } from "@vykor/protocol";

export interface AppAdmitClientPromptInput extends CoreAdmitClientPromptInput {
  pluginAppContexts?: PluginAppConversationRequest[];
}
export type AdmitClientPromptInput = AppAdmitClientPromptInput;

export interface ScheduledTaskStatusSummary {
  running: true;
  tasks: number;
  active: number;
  paused: number;
  executing: number;
  unread: number;
}

export type CommandKind = "session" | "template";

export type CommandSelection = "execute" | "submenu" | "insert";

export type CommandSource =
  "builtin" | "bundled" | "user" | "plugin" | "project";

interface CommandCatalogEntryBase {
  name: string;
  displayName?: string;
  description?: string;
  source?: CommandSource;
  argumentHint?: string;
  selection?: CommandSelection;
  requiresEmptyComposer?: boolean;
}

export type CommandCatalogEntry = CommandCatalogEntryBase & (
  | { kind: "session"; path?: never; skillName?: never }
  | { kind: "template"; path: string; skillName: string }
);

export interface ListCommandsOptions {
  cwd: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  pinnedAt?: number;
  defaultShell?: string;
  lastOpenedAt: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ListProjectsOptions {
  includeArchived?: boolean;
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
  custom?: boolean;
  requiresApiKey?: boolean;
  source?: "builtin" | "catalog" | "custom" | "subscription";
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  apiKey?: string;
  models: Array<{
    id: string;
    displayName: string;
    imageInputSupport?: "native" | "unsupported" | "unknown";
    /** 用户自填的上下文窗口（tokens）；留空时服务端按模型 id 查目录。 */
    contextWindow?: number;
    /** 用户自填的最大输出（tokens）；留空时服务端按模型 id 查目录。 */
    maxOutputTokens?: number;
  }>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string | null>;
}

export interface ConnectCatalogProviderInput {
  apiKey: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string | null>;
}

export interface UpdateCatalogProviderHeadersInput {
  headers: Record<string, string>;
}

export type McpRuntimeStatus = "connected" | "disconnected" | "error" | "unavailable";

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}

export interface MemoryListResponse {
  directory: string;
  entries: MemoryEntryRecord[];
}

export interface AuthStatus {
  codex: {
    configured: boolean;
    state: string;
    source: string;
    detail?: string;
    profileLabel?: string;
  };
  storedProviders: string[];
  envProviders: Array<{ name: string; envKey: string }>;
}

export interface ReloadPluginsResponse {
  plugins: PluginInfo[];
  warnings: string[];
  message: string;
}

export interface StartDreamResponse {
  taskId: string;
}

export interface OutputStyleInfo {
  name: string;
  content: string;
  source: "builtin" | "user";
}
