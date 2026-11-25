import type { InputDelivery, PermissionStatus, SessionStorage } from "./session.js";
import type { AttachmentIntent } from "../attachments/attachment.js";
import type { SessionUserInputItem } from "./session-input-items.js";

export interface CreateSessionInput {
  id?: string;
  storage?: SessionStorage;
  parentId?: string;
  projectId?: string;
  cwd: string;
  title?: string;
  model: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkSessionInput {
  copyHistory?: boolean;
  beforeMessageId?: string;
  afterMessageId?: string;
  storage?: SessionStorage;
}

export interface UpdateSessionInput {
  title?: string;
  model?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Narrow maintenance input: clear only a matching, already-removed worktree binding. */
export interface ClearSessionWorktreeBindingInput {
  id: string;
  path: string;
  branch: string;
}

/** Optional Input.metadata.replyPresentation value and its Markdown fence language. */
export const INTERACTIVE_UI_REPLY_FORMAT = "vykor-ui-v1";

export interface AdmitPromptInput {
  pluginAppContexts?: import("../extensions/plugin-apps.js").PluginAppConversationRequest[];
  id?: string;
  sessionId: string;
  delivery?: InputDelivery;
  /** Bind a steer to the running turn the caller observed. */
  expectedActiveRunId?: string;
  /** Validated structured delivery required for this queued Run. */
  outputSchema?: Record<string, unknown>;
  items: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface AdmitPromptAttachmentInput {
  assetId: string;
  intent?: AttachmentIntent;
  displayName?: string;
}

export interface ReplyPermissionInput {
  requestId: string;
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: string;
  clientId?: string;
  answer?: string;
}


/** Public query parameters, independently mapped to storage query options. */
export interface ListMessagePartsOptions { afterSeq?: number; messageId?: string; limit?: number }
