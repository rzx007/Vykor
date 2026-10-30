/** External lifecycle consumer. Product administration is intentionally absent. */
import { VykorClient, CURRENT_PROTOCOL_VERSION, checkProtocolCompatibility, supportsFeature,
  VykorApiError, IncompatibleProtocolError, SessionSyncController, syncEvents, waitForRun,
  applyEvent, createInitialClientState, selectFirstPendingPermission, type ModelProviderInfo, type SkillSnapshot,
  type CreateClientSessionInput, type UploadAttachmentInput, type ReplyPermissionInput,
  type SessionRunRecord, type AdmitClientPromptInput,
} from "@rzx/client";
// @ts-expect-error product data is not part of the lifecycle SDK
import type { NoteRecord } from "@rzx/client";
// @ts-expect-error product installation is private
import type { MarketplaceCatalog } from "@rzx/client";
// @ts-expect-error plugin application UI is private
import type { PluginAppConversationRequest } from "@rzx/client";

export async function consumePublicApi(client: VykorClient, signal: AbortSignal): Promise<void> {
  const capabilities = await client.protocol.capabilities({ signal });
  const compatible = checkProtocolCompatibility(capabilities, { version: CURRENT_PROTOCOL_VERSION });
  if (!compatible.compatible) throw new IncompatibleProtocolError(capabilities, "different protocol");
  const health = await client.protocol.health({ signal });
  if (!health.ok) throw new VykorApiError("unhealthy", 503, health);
  const models: ModelProviderInfo[] = await client.runtime.listModels({ signal });
  const skills: SkillSnapshot = await client.runtime.listSkills({ signal });
  await client.runtime.listAgentPersonas({ signal });
  const input: CreateClientSessionInput = { cwd: "/workspace", model: models[0]!.models[0]!.id };
  const session = await client.sessions.create(input, { signal });
  await client.sessions.update(session.id, { title: "Agent lifecycle" }, { signal });
  await client.runtime.getSessionMcp(session.id, { signal });
  const upload: UploadAttachmentInput = { displayName: "input.txt", body: new Uint8Array([1]) };
  const asset = await client.attachments.upload(upload);
  await client.attachments.get(asset.id, { signal });
  await client.attachments.download(asset.id, { signal, range: { start: 0, end: 20 } });
  const prompt: AdmitClientPromptInput = { id: "stable-input", items: [{ type: "text", text: "Inspect the project" }] };
  selectFirstPendingPermission(createInitialClientState(), session.id);
  const snapshot = await client.sessions.getState(session.id, { signal });
  // @ts-expect-error application snapshot extensions are private
  snapshot.pluginApps;
  const admission = await client.sessions.admitPrompt(session.id, prompt, { signal });
  if (admission.run) {
    const result = await waitForRun(client, { sessionId: session.id, runId: admission.run.id, signal });
    const run: SessionRunRecord = result.run;
    void [run, result.messages];
    await client.sessions.interrupt(session.id, { expectedRunId: run.id, signal });
    await client.sessions.resumeInterruptedRun(session.id, run.id, { id: "resume-once" }, { signal });
  }
  const decision: ReplyPermissionInput = { status: "denied" };
  await client.permissions.list({ sessionId: session.id, signal });
  await client.permissions.reply("permission", decision, { signal });
  const jobs = await client.jobs.list({ sessionId: session.id, signal });
  const target = { kind: "agent" as const, jobId: "child", runId: "exact-run" };
  await client.jobs.read(target, { sessionId: session.id, signal });
  await client.jobs.wait(target, { sessionId: session.id }, { signal });
  await client.jobs.send(target, { sessionId: session.id, data: "continue" }, { signal });
  await client.jobs.cancel(target, { sessionId: session.id }, { signal });
  // @ts-expect-error agent job commands must select an exact run
  await client.jobs.cancel({ kind: "agent", jobId: "child" }, { sessionId: session.id });
  const controller = new SessionSyncController({ client, sessionId: session.id, signal, generation: 1, onUpdate: () => {} });
  void [controller, jobs.errors, skills, supportsFeature(capabilities, "jobs")];
  for await (const update of syncEvents(client, { sessionId: session.id, signal })) {
    if (update.event) applyEvent(createInitialClientState(), update.event);
    break;
  }
  await client.sessions.getState(session.id, { signal });
  await client.sessions.listMessages(session.id, { signal });
  await client.sessions.fork(session.id, {}, { signal });
  await client.sessions.compact(session.id, { signal });
  await client.sessions.rewind(session.id, { count: 1 }, { signal });
  await client.sessions.archive(session.id, { signal });
  await client.sessions.delete(session.id, { signal });
}

export function rejectApplicationApi(client: VykorClient): void {
  // @ts-expect-error product notes are private
  client.notes;
  // @ts-expect-error delivery channels are private
  client.channels;
  // @ts-expect-error scheduled product tasks are private
  client.schedules;
  // @ts-expect-error daemon administration is private
  client.system;
  // @ts-expect-error provider credentials are private
  client.providers;
  // @ts-expect-error plugin installation is private
  client.plugins;
  // @ts-expect-error terminal administration is private
  client.terminals;
  // @ts-expect-error storage administration is private
  client.attachments.scanStorage();
  // @ts-expect-error desktop worktree cleanup is private
  client.sessions.clearWorktreeBinding;
  // @ts-expect-error application contexts are not an Agent prompt field
  const input: AdmitClientPromptInput = { items: [], pluginAppContexts: [] };
  void input;
}

export function rejectRemovedFlatApi(client: VykorClient): void {
  // @ts-expect-error removed flat compatibility API
  client.addMemory;
  // @ts-expect-error removed flat compatibility API
  client.admitPrompt;
  // @ts-expect-error removed flat compatibility API
  client.applySessionGoalAction;
  // @ts-expect-error removed flat compatibility API
  client.archiveProject;
  // @ts-expect-error removed flat compatibility API
  client.archiveSession;
  // @ts-expect-error removed flat compatibility API
  client.authLogin;
  // @ts-expect-error removed flat compatibility API
  client.authLogout;
  // @ts-expect-error removed flat compatibility API
  client.cancelJob;
  // @ts-expect-error removed flat compatibility API
  client.cancelQueuedPrompt;
  // @ts-expect-error removed flat compatibility API
  client.capabilities;
  // @ts-expect-error removed flat compatibility API
  client.closeTerminal;
  // @ts-expect-error removed flat compatibility API
  client.compactSession;
  // @ts-expect-error removed flat compatibility API
  client.connectCatalogProvider;
  // @ts-expect-error removed flat compatibility API
  client.createBackgroundShell;
  // @ts-expect-error removed flat compatibility API
  client.createCustomProvider;
  // @ts-expect-error removed flat compatibility API
  client.createScheduledTask;
  // @ts-expect-error removed flat compatibility API
  client.createSession;
  // @ts-expect-error removed flat compatibility API
  client.createSessionGoal;
  // @ts-expect-error removed flat compatibility API
  client.createTerminal;
  // @ts-expect-error removed flat compatibility API
  client.deleteAttachment;
  // @ts-expect-error removed flat compatibility API
  client.deleteSession;
  // @ts-expect-error removed flat compatibility API
  client.disablePlugin;
  // @ts-expect-error removed flat compatibility API
  client.disconnectCatalogProvider;
  // @ts-expect-error removed flat compatibility API
  client.downloadAttachment;
  // @ts-expect-error removed flat compatibility API
  client.editLatestPrompt;
  // @ts-expect-error removed flat compatibility API
  client.enablePlugin;
  // @ts-expect-error removed flat compatibility API
  client.exportSession;
  // @ts-expect-error removed flat compatibility API
  client.forkSession;
  // @ts-expect-error removed flat compatibility API
  client.gcAttachmentStorage;
  // @ts-expect-error removed flat compatibility API
  client.getAttachment;
  // @ts-expect-error removed flat compatibility API
  client.getAuthStatus;
  // @ts-expect-error removed flat compatibility API
  client.getChannelStatus;
  // @ts-expect-error removed flat compatibility API
  client.getContextPreview;
  // @ts-expect-error removed flat compatibility API
  client.getContextStatus;
  // @ts-expect-error removed flat compatibility API
  client.getContextUsage;
  // @ts-expect-error removed flat compatibility API
  client.getGitBranch;
  // @ts-expect-error removed flat compatibility API
  client.getGitDiff;
  // @ts-expect-error removed flat compatibility API
  client.getGitStatus;
  // @ts-expect-error removed flat compatibility API
  client.getMemory;
  // @ts-expect-error removed flat compatibility API
  client.getProfileStatus;
  // @ts-expect-error removed flat compatibility API
  client.getScheduledTask;
  // @ts-expect-error removed flat compatibility API
  client.getScheduledTaskStatus;
  // @ts-expect-error removed flat compatibility API
  client.getSession;
  // @ts-expect-error removed flat compatibility API
  client.getSessionGoal;
  // @ts-expect-error removed flat compatibility API
  client.getSessionMcp;
  // @ts-expect-error removed flat compatibility API
  client.getSessionState;
  // @ts-expect-error removed flat compatibility API
  client.getSessionUsage;
  // @ts-expect-error removed flat compatibility API
  client.getSettings;
  // @ts-expect-error removed flat compatibility API
  client.getTerminal;
  // @ts-expect-error removed flat compatibility API
  client.gitCommit;
  // @ts-expect-error removed flat compatibility API
  client.handleChannelMessage;
  // @ts-expect-error removed flat compatibility API
  client.health;
  // @ts-expect-error removed flat compatibility API
  client.initProfile;
  // @ts-expect-error removed flat compatibility API
  client.initProject;
  // @ts-expect-error removed flat compatibility API
  client.inspectProject;
  // @ts-expect-error removed flat compatibility API
  client.installLocalPlugin;
  // @ts-expect-error removed flat compatibility API
  client.installPluginArchive;
  // @ts-expect-error removed flat compatibility API
  client.installPluginGit;
  // @ts-expect-error removed flat compatibility API
  client.interruptSession;
  // @ts-expect-error removed flat compatibility API
  client.listAgentPersonas;
  // @ts-expect-error removed flat compatibility API
  client.listCommands;
  // @ts-expect-error removed flat compatibility API
  client.listContextPlugins;
  // @ts-expect-error removed flat compatibility API
  client.listEvents;
  // @ts-expect-error removed flat compatibility API
  client.listHooks;
  // @ts-expect-error removed flat compatibility API
  client.listJobs;
  // @ts-expect-error removed flat compatibility API
  client.listMemory;
  // @ts-expect-error removed flat compatibility API
  client.listMessageParts;
  // @ts-expect-error removed flat compatibility API
  client.listMessages;
  // @ts-expect-error removed flat compatibility API
  client.listModels;
  // @ts-expect-error removed flat compatibility API
  client.listOutputStyles;
  // @ts-expect-error removed flat compatibility API
  client.listPendingChannelDeliveries;
  // @ts-expect-error removed flat compatibility API
  client.listPermissions;
  // @ts-expect-error removed flat compatibility API
  client.listPlugins;
  // @ts-expect-error removed flat compatibility API
  client.listProjects;
  // @ts-expect-error removed flat compatibility API
  client.listProviders;
  // @ts-expect-error removed flat compatibility API
  client.listScheduledRuns;
  // @ts-expect-error removed flat compatibility API
  client.listScheduledTasks;
  // @ts-expect-error removed flat compatibility API
  client.listSessions;
  // @ts-expect-error removed flat compatibility API
  client.listSkills;
  // @ts-expect-error removed flat compatibility API
  client.listTerminals;
  // @ts-expect-error removed flat compatibility API
  client.patchSettings;
  // @ts-expect-error removed flat compatibility API
  client.previewPluginArchive;
  // @ts-expect-error removed flat compatibility API
  client.previewPluginGit;
  // @ts-expect-error removed flat compatibility API
  client.promoteQueuedPrompt;
  // @ts-expect-error removed flat compatibility API
  client.readJob;
  // @ts-expect-error removed flat compatibility API
  client.readTerminal;
  // @ts-expect-error removed flat compatibility API
  client.rebindProject;
  // @ts-expect-error removed flat compatibility API
  client.recordChannelDelivery;
  // @ts-expect-error removed flat compatibility API
  client.reloadPlugins;
  // @ts-expect-error removed flat compatibility API
  client.rememberSession;
  // @ts-expect-error removed flat compatibility API
  client.removeCustomProvider;
  // @ts-expect-error removed flat compatibility API
  client.removeMemory;
  // @ts-expect-error removed flat compatibility API
  client.removeScheduledTask;
  // @ts-expect-error removed flat compatibility API
  client.removeSkill;
  // @ts-expect-error removed flat compatibility API
  client.renameProject;
  // @ts-expect-error removed flat compatibility API
  client.repairAttachmentStorage;
  // @ts-expect-error removed flat compatibility API
  client.replyPermission;
  // @ts-expect-error removed flat compatibility API
  client.resizeTerminal;
  // @ts-expect-error removed flat compatibility API
  client.resumeInterruptedRun;
  // @ts-expect-error removed flat compatibility API
  client.rewindSession;
  // @ts-expect-error removed flat compatibility API
  client.scanAttachmentStorage;
  // @ts-expect-error removed flat compatibility API
  client.sendJob;
  // @ts-expect-error removed flat compatibility API
  client.setProjectDefaultShell;
  // @ts-expect-error removed flat compatibility API
  client.setProjectPinned;
  // @ts-expect-error removed flat compatibility API
  client.setScheduledRunUnread;
  // @ts-expect-error removed flat compatibility API
  client.signalTerminal;
  // @ts-expect-error removed flat compatibility API
  client.startDream;
  // @ts-expect-error removed flat compatibility API
  client.streamEvents;
  // @ts-expect-error removed flat compatibility API
  client.streamTerminalEvents;
  // @ts-expect-error removed flat compatibility API
  client.triggerScheduledTask;
  // @ts-expect-error removed flat compatibility API
  client.uninstallPlugin;
  // @ts-expect-error removed flat compatibility API
  client.updateCustomProvider;
  // @ts-expect-error removed flat compatibility API
  client.updateScheduledTask;
  // @ts-expect-error removed flat compatibility API
  client.updateSession;
  // @ts-expect-error removed flat compatibility API
  client.updateSessionGoal;
  // @ts-expect-error removed flat compatibility API
  client.uploadAttachment;
  // @ts-expect-error removed flat compatibility API
  client.waitJob;
  // @ts-expect-error removed flat compatibility API
  client.writeTerminal;
}
