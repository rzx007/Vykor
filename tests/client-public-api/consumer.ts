/**
 * Representative external consumer type fixture for @openharness/client.
 * Verifies public contract can be cleanly consumed without any relative imports, any, or ts-ignore.
 */
import {
  OpenHarnessClient,
  OpenHarnessApiError,
  IncompatibleProtocolError,
  CURRENT_PROTOCOL_VERSION,
  checkProtocolCompatibility,
  supportsFeature,
  applyEvent,
  createInitialClientState,
  SessionSyncController,
  type ServerCapabilities,
  type ProtocolCompatibility,
  type SessionRecord,
  type CreateClientSessionInput,
  type UploadAttachmentInput,
  type AttachmentAssetRecord,
  type ReplyPermissionInput,
  type PermissionRequestRecord,
  type CreateScheduledTaskInput,
  type ScheduledTaskRecord,
  type CreateBackgroundShellInput,
  type CreateBackgroundShellResult,
  type TerminalCreateRequest,
  type TerminalSessionInfo,
  type DurableChannelMessageInput,
  type DurableChannelMessageResult,
  type ListEventsOptions,
  type SessionEventRecord,
  type OpenHarnessServerHealth,
  type ModelProviderInfo,
  type AuthStatus,
  type ProjectRecord,
  type PluginInfo,
  type SkillSnapshot,
} from "@openharness/client";

export async function consumePublicApi(client: OpenHarnessClient): Promise<void> {
  // Protocol checks
  const serverCaps: ServerCapabilities = await client.protocol.capabilities();
  const currentVersion: number = CURRENT_PROTOCOL_VERSION;
  const compatibility: ProtocolCompatibility = checkProtocolCompatibility(serverCaps, {
    version: currentVersion,
  });
  const hasFeature: boolean = supportsFeature(serverCaps, "attachments");
  if (!compatibility.compatible || !hasFeature) {
    throw new IncompatibleProtocolError(serverCaps, compatibility.reason ?? "Protocol incompatible");
  }

  // Protocol Resource
  const health: OpenHarnessServerHealth = await client.protocol.health();
  if (!health.ok) {
    throw new OpenHarnessApiError("Health check failed", 500, { error: "unhealthy" });
  }

  // System Resource
  await client.system.getSettings();

  // Sessions Resource
  const createInput: CreateClientSessionInput = {
    cwd: "/workspace",
    model: "claude-3-5-sonnet",
    title: "Fixture session",
  };
  const session: SessionRecord = await client.sessions.create(createInput);
  const fetchedSession: SessionRecord = await client.sessions.get(session.id);

  // Attachments Resource
  const uploadInput: UploadAttachmentInput = {
    displayName: "test.txt",
    mediaType: "text/plain",
    body: new Uint8Array([1, 2, 3]),
  };
  const attachment: AttachmentAssetRecord = await client.attachments.upload(uploadInput);
  await client.attachments.get(attachment.id);

  // Permissions Resource
  const permissionInput: ReplyPermissionInput = {
    status: "approved",
    decision: "once",
  };
  const permission: PermissionRequestRecord = await client.permissions.reply("req-1", permissionInput);

  // Schedules Resource
  const taskInput: CreateScheduledTaskInput = {
    name: "Daily Task",
    prompt: "daily check",
    recurrence: "0 0 * * *",
    recurrenceFormat: "once",
    timezone: "UTC",
    destination: "standalone",
  };
  const task: ScheduledTaskRecord = await client.schedules.createTask(taskInput);

  // Jobs Resource
  const shellInput: CreateBackgroundShellInput = {
    sessionId: session.id,
    command: "echo test",
  };
  const shellJob: CreateBackgroundShellResult = await client.jobs.createBackgroundShell(shellInput);

  // Terminals Resource
  const termRequest: TerminalCreateRequest = {
    scope: { kind: "session", sessionId: session.id },
    runtime: "local",
    cols: 80,
    rows: 24,
    shell: "bash",
  };
  const terminal: TerminalSessionInfo = await client.terminals.create(termRequest);

  // Channels Resource
  const channelMsg: DurableChannelMessageInput = {
    connector: "slack",
    accountId: "acc-1",
    chatId: "chat-1",
    externalMessageId: "msg-1",
    senderId: "user-1",
    content: "ping",
    cwd: "/workspace",
    model: "claude-3-5-sonnet",
  };
  const channelRes: DurableChannelMessageResult = await client.channels.handleMessage(channelMsg);

  // Events Resource
  const eventOptions: ListEventsOptions = {
    sessionId: session.id,
    limit: 10,
  };
  const events: SessionEventRecord[] = await client.events.list(eventOptions);

  // Providers, Auth, Projects, Plugins, Development Resources
  const models: ModelProviderInfo[] = await client.providers.listModels();
  const authStatus: AuthStatus = await client.auth.getStatus();
  const projects: ProjectRecord[] = await client.projects.list();
  const pluginResult: { plugins: PluginInfo[]; warnings: string[] } = await client.plugins.list({ cwd: "/workspace" });
  const skills: SkillSnapshot = await client.development.listSkills();

  // State / Sync API
  const initialState = createInitialClientState();
  if (events.length > 0) {
    const firstEvent = events[0];
    if (firstEvent) {
      applyEvent(initialState, firstEvent);
    }
  }

  const syncAbort = new AbortController();
  const controller = new SessionSyncController({
    sessionId: session.id,
    signal: syncAbort.signal,
    client: {
      sessions: {
        getState: (id, opts) => client.sessions.getState(id, opts),
      },
      events: {
        list: (opts) => client.events.list(opts),
        stream: (opts) => client.events.stream(opts),
      },
    },
  });
  syncAbort.abort();

  void [controller, permission, task, shellJob, terminal, channelRes, models, authStatus, projects, pluginResult, skills];
}

export function rejectRemovedFlatApi(client: OpenHarnessClient): void {
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
