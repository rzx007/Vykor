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

  // Stage 7 Deprecated Flat API Compatibility Check
  // Call deprecated flat method to verify compatibility layer still compiles and types properly
  const flatSessionPromise: Promise<SessionRecord> = client.getSession(fetchedSession.id);
  await flatSessionPromise;

  void [controller, permission, task, shellJob, terminal, channelRes, models, authStatus, projects, pluginResult, skills];
}
