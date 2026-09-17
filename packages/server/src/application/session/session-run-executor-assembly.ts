import { discoverOpenHarnessExtensions } from "@openharness/agent-runtime";
import type { Settings } from "@openharness/core";
import { readSessionRuntimeConfig, type SessionRecord, type SessionUserInputItem } from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";

import type { AttachmentService } from "../attachments/attachment-service.js";
import { AttachmentCapabilityRouter } from "../attachment-routing/attachment-capability-router.js";
import { resolveRuntimeAttachmentCapabilities } from "../attachment-routing/attachment-capabilities.js";
import { createDefaultModelService } from "../default-services/model-service.js";
import { conversationContextCatalog } from "./session-conversation-context.js";
import { materializeSessionInput } from "./session-input-materializer.js";
import { SessionRunExecutor, type SessionRunExecutorContext } from "./session-run-executor.js";

export interface SessionRunExecutorAssemblyOptions extends Omit<SessionRunExecutorContext,
  "data" | "attachments" | "resolveSkillCatalog" | "routeAttachments" | "resolveCapabilities"
> {
  store: Pick<SessionStore,
    "attachments" | "conversations" | "conversationTransactions" |
    "runs" | "sessions" | "transaction"
  >;
  attachmentService: Pick<AttachmentService, "resolveReadyContentPath" | "readReadyText">;
  resolveSessionSettings(cwd: string): Promise<Settings | undefined>;
}

export function assembleSessionRunExecutor(options: SessionRunExecutorAssemblyOptions): {
  executor: SessionRunExecutor;
  materializeSteerInput(sessionId: string, items: readonly SessionUserInputItem[]): Promise<string>;
} {
  const attachmentRouter = new AttachmentCapabilityRouter({
    resolveReadyContentPath: (assetId) => options.attachmentService.resolveReadyContentPath(assetId),
    readReadyText: (assetId, readOptions) => options.attachmentService.readReadyText(assetId, readOptions),
  });
  const resolveSkillCatalog = async (session: SessionRecord) => {
    const settings = await options.resolveSessionSettings(session.cwd);
    if (!settings) throw new Error("session_input_skill_catalog_unavailable");
    return (await discoverOpenHarnessExtensions(session.cwd, settings)).skillRegistry;
  };
  const materializeSteerInput = async (sessionId: string, items: readonly SessionUserInputItem[]) => {
    const session = options.store.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return materializeSessionInput(items, await resolveSkillCatalog(session), conversationContextCatalog({
      getSession: (id) => options.store.sessions.get(id),
      listMessages: (id) => options.store.conversations.listMessages(id),
      listMessageParts: (id) => options.store.conversations.listMessageParts(id),
    }, sessionId)).instruction;
  };
  const executor = new SessionRunExecutor({
    ...options,
    data: options.store,
    attachments: options.store.attachments,
    resolveSkillCatalog,
    routeAttachments: (input) => attachmentRouter.route(input),
    resolveCapabilities: async (session) => {
      const settings = await options.resolveSessionSettings(session.cwd);
      const modelProviders = await createDefaultModelService(settings ? { current: settings } : undefined).list();
      return resolveRuntimeAttachmentCapabilities({
        runtime: readSessionRuntimeConfig(session, settings?.provider ? { provider: settings.provider } : undefined),
        settings,
        modelProviders,
      });
    },
  });
  return { executor, materializeSteerInput };
}
