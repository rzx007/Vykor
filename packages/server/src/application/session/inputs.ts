/** Application commands; HTTP and storage inputs map into these explicitly. */
import type { InputDelivery, PermissionStatus, SessionStorage } from "@vykor/domain-contracts/sessions";
import type { SessionUserInputItem, PromptAttachment as AdmitPromptAttachmentInput } from "@vykor/domain-contracts/inputs";
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

export interface ClearSessionWorktreeBindingInput {
  id: string;
  path: string;
  branch: string;
}

export interface AdmitPromptInput {
  pluginAppContexts?: import("@vykor/domain-contracts/plugin-apps").PluginAppConversationInput[];
  id?: string;
  sessionId: string;
  delivery?: InputDelivery;
  items: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface ReplyPermissionInput {
  requestId: string;
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: string;
  clientId?: string;
  answer?: string;
}
