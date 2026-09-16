import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "session",
  {
    id: text("id"),
    parentId: text("parent_id"),
    projectId: text("project_id").references(() => projects.id),
    cwd: text("cwd").notNull(),
    cwdRelative: text("cwd_relative"),
    title: text("title").notNull(),
    model: text("model").notNull(),
    agent: text("agent"),
    status: text("status").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("session_parent_idx").on(table.parentId),
    index("session_cwd_updated_idx").on(table.cwd, table.updatedAt),
  ],
);

export const projects = sqliteTable("project", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  pinnedAt: integer("pinned_at"),
  defaultShell: text("default_shell"),
  lastOpenedAt: integer("last_opened_at").notNull(),
  archivedAt: integer("archived_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectLocations = sqliteTable(
  "project_location",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    normalizedPath: text("normalized_path").notNull(),
    status: text("status").notNull(),
    boundAt: integer("bound_at").notNull(),
    lastVerifiedAt: integer("last_verified_at"),
  },
  (table) => [
    index("project_location_project_idx").on(table.projectId, table.status),
    uniqueIndex("project_location_active_path").on(table.normalizedPath).where(sql`${table.status} = 'active'`),
    uniqueIndex("project_location_active_project").on(table.projectId).where(sql`${table.status} = 'active'`),
  ],
);

export const sessionInputs = sqliteTable(
  "session_input",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    delivery: text("delivery").notNull(),
    content: text("content").notNull(),
    itemsJson: text("items_json"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    unique("session_input_session_seq").on(table.sessionId, table.seq),
    index("session_input_session_idx").on(table.sessionId),
  ],
);

export const attachmentAssets = sqliteTable(
  "attachment_asset",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    declaredMediaType: text("declared_media_type"),
    mediaType: text("media_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    status: text("status").notNull(),
    stagingName: text("staging_name"),
    failureCode: text("failure_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("attachment_asset_hash_status_idx").on(table.sha256, table.status),
    index("attachment_asset_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

export const attachmentRepresentations = sqliteTable(
  "attachment_representation",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => attachmentAssets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    processor: text("processor").notNull(),
    processorVersion: text("processor_version").notNull(),
    cacheKey: text("cache_key").notNull(),
    mediaType: text("media_type").notNull(),
    text: text("text"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("attachment_representation_asset_kind_cache_unique").on(
      table.assetId,
      table.kind,
      table.cacheKey,
    ),
    index("attachment_representation_asset_idx").on(table.assetId, table.createdAt),
  ],
);

export const attachmentLeases = sqliteTable(
  "attachment_lease",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => attachmentAssets.id, { onDelete: "cascade" }),
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    createdAt: integer("created_at").notNull(),
    renewedAt: integer("renewed_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("attachment_lease_asset_owner_unique").on(
      table.assetId,
      table.ownerKind,
      table.ownerId,
    ),
    index("attachment_lease_expiry_idx").on(table.expiresAt, table.assetId),
  ],
);

export const sessionInputAttachments = sqliteTable(
  "session_input_attachment",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    inputId: text("input_id")
      .notNull()
      .references(() => sessionInputs.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => attachmentAssets.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    intent: text("intent").notNull(),
    displayName: text("display_name").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("session_input_attachment_input_seq_unique").on(table.inputId, table.seq),
    unique("session_input_attachment_input_asset_unique").on(table.inputId, table.assetId),
    index("session_input_attachment_input_seq_idx").on(table.inputId, table.seq),
    index("session_input_attachment_asset_idx").on(table.assetId),
    index("session_input_attachment_session_idx").on(table.sessionId),
  ],
);

export const sessionMessages = sqliteTable(
  "session_message",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    runId: text("run_id"),
    inputId: text("input_id"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    unique("session_message_session_seq").on(table.sessionId, table.seq),
    index("session_message_session_idx").on(table.sessionId),
  ],
);

export const sessionMessageParts = sqliteTable(
  "session_message_part",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    text: text("text"),
    toolUseId: text("tool_use_id"),
    toolName: text("tool_name"),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    isError: integer("is_error"),
    assetId: text("asset_id"),
    attachmentIntent: text("attachment_intent"),
    displayName: text("display_name"),
    mediaType: text("media_type"),
    sizeBytes: integer("size_bytes"),
    transformationKind: text("transformation_kind"),
    representationId: text("representation_id"),
    processor: text("processor"),
    transformationError: text("transformation_error"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    unique("session_part_session_seq").on(table.sessionId, table.seq),
    index("session_part_message_idx").on(table.messageId),
  ],
);

export const sessionRuns = sqliteTable(
  "session_run",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    inputId: text("input_id"),
    status: text("status").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("session_run_session_idx").on(table.sessionId, table.createdAt),
    index("session_run_input_idx").on(table.inputId),
  ],
);

export const sessionGoals = sqliteTable(
  "session_goal",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    objective: text("objective").notNull(),
    pluginId: text("plugin_id"),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
    maxAutoTurns: integer("max_auto_turns").notNull(),
    autoTurnsUsed: integer("auto_turns_used").notNull(),
    noProgressCount: integer("no_progress_count").notNull(),
    blockerKey: text("blocker_key"),
    lastAssessmentJson: text("last_assessment_json"),
    currentRunId: text("current_run_id"),
    reason: text("reason"),
    waitJson: text("wait_json"),
    evidenceJson: text("evidence_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("session_goal_session_updated_idx").on(table.sessionId, table.updatedAt),
    uniqueIndex("session_goal_session_open_unique").on(table.sessionId)
      .where(sql`${table.status} IN ('active','waiting_user','blocked','paused')`),
  ],
);

export const sessionGoalRequests = sqliteTable(
  "session_goal_request",
  {
    requestId: text("request_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    goalId: text("goal_id"),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("session_goal_request_session_idx").on(table.sessionId, table.updatedAt)],
);

export const sessionGoalAssessments = sqliteTable(
  "session_goal_assessment",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => sessionGoals.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    runId: text("run_id").notNull(),
    assessmentJson: text("assessment_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_goal_assessment_run_unique").on(table.goalId, table.revision, table.runId),
  ],
);

export const sessionGoalContinuations = sqliteTable(
  "session_goal_continuation",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => sessionGoals.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    previousRunId: text("previous_run_id").notNull(),
    inputId: text("input_id"),
    runId: text("run_id"),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_goal_continuation_previous_unique").on(
      table.goalId,
      table.revision,
      table.previousRunId,
    ),
  ],
);

export const sessionRunAttempts = sqliteTable(
  "session_run_attempt",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    model: text("model"),
    retryReason: text("retry_reason"),
    errorKind: text("error_kind"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_run_attempt_run_sequence_unique").on(table.runId, table.sequence),
    index("session_run_attempt_run_idx").on(table.runId),
    index("session_run_attempt_status_idx").on(table.status),
  ],
);

export const externalConversations = sqliteTable(
  "external_conversation",
  {
    id: text("id").primaryKey(),
    connector: text("connector").notNull(),
    accountId: text("account_id").notNull(),
    workspaceId: text("workspace_id"),
    chatId: text("chat_id").notNull(),
    threadId: text("thread_id").notNull().default(""),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("external_conversation_identity_unique").on(
      table.connector,
      table.accountId,
      table.chatId,
      table.threadId,
    ),
    index("external_conversation_session_idx").on(table.sessionId),
  ],
);

export const channelDeliveries = sqliteTable(
  "channel_delivery",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => externalConversations.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    accountId: text("account_id").notNull(),
    chatId: text("chat_id").notNull(),
    threadId: text("thread_id").notNull().default(""),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    inputId: text("input_id")
      .notNull()
      .references(() => sessionInputs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => sessionRuns.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    externalDeliveryId: text("external_delivery_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    uniqueIndex("channel_delivery_input_unique").on(table.inputId),
    index("channel_delivery_status_idx").on(table.status, table.updatedAt),
  ],
);

export const workflowRuns = sqliteTable(
  "workflow_run",
  {
    runId: text("run_id").primaryKey(),
    ownerSessionId: text("owner_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    ownerInputId: text("owner_input_id").references(() => sessionInputs.id, {
      onDelete: "set null",
    }),
    ownerRunId: text("owner_run_id").references(() => sessionRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(),
    termination: text("termination"),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("workflow_run_owner_idx").on(table.ownerSessionId, table.updatedAt),
    index("workflow_run_status_idx").on(table.status, table.updatedAt),
  ],
);

export const workflowTaskAttempts = sqliteTable(
  "workflow_task_attempt",
  {
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    payloadJson: text("payload_json").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowRunId, table.taskId, table.attempt] }),
  ],
);

export const workflowEvents = sqliteTable(
  "workflow_event",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    type: text("type").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("workflow_event_run_seq_idx").on(table.workflowRunId, table.seq),
  ],
);

export const workflowExecutionClaims = sqliteTable("workflow_execution_claim", {
  workflowRunId: text("workflow_run_id")
    .primaryKey()
    .references(() => workflowRuns.runId, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  generation: integer("generation").notNull(),
  claimedAt: integer("claimed_at").notNull(),
  heartbeatAt: integer("heartbeat_at").notNull(),
  finishedAt: integer("finished_at"),
  status: text("status").notNull(),
});

export const applicationOwners = sqliteTable("application_owner", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id").notNull(),
  pid: integer("pid").notNull(),
  generation: integer("generation").notNull(),
  startedAt: integer("started_at").notNull(),
  heartbeatAt: integer("heartbeat_at").notNull(),
});

export const retentionAudits = sqliteTable("retention_audit", {
  id: text("id").primaryKey(),
  policy: text("policy").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessionTasks = sqliteTable(
  "session_task",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    requestNamespace: text("request_namespace"),
    requestId: text("request_id"),
    childSessionId: text("child_session_id"),
    runId: text("run_id"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    description: text("description").notNull(),
    cwd: text("cwd").notNull(),
    output: text("output"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("session_task_session_idx").on(table.sessionId, table.createdAt),
    uniqueIndex("session_task_request_identity_idx").on(
      table.sessionId,
      table.requestNamespace,
      table.requestId,
    ),
  ],
);

export const permissionRequests = sqliteTable(
  "permission_request",
  {
    id: text("id"),
    sessionId: text("session_id").notNull(),
    runId: text("run_id"),
    toolName: text("tool_name").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    decision: text("decision"),
    decidedByClientId: text("decided_by_client_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("permission_session_status_idx").on(table.sessionId, table.status),
  ],
);

export const sessionEvents = sqliteTable(
  "session_event",
  {
    id: text("id"),
    seq: integer("seq").notNull().unique(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    sessionId: text("session_id"),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("session_event_session_seq_idx").on(table.sessionId, table.seq),
  ],
);

export const sessionEventSequence = sqliteTable("session_event_sequence", {
  id: integer("id"),
  reservedThrough: integer("reserved_through").notNull(),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  check("session_event_sequence_singleton", sql`${table.id} = 1`),
]);

export const applicationStorageFormat = sqliteTable("application_storage_format", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
}, (table) => [check("application_storage_format_singleton", sql`${table.id} = 1`)]);

export const projectionSettlements = sqliteTable(
  "projection_settlement",
  {
    id: text("id").primaryKey(),
    projector: text("projector").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    eventSequence: integer("event_sequence").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    nextRetryAt: integer("next_retry_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    uniqueIndex("projection_settlement_event_idx").on(
      table.projector,
      table.rootSessionId,
      table.eventSequence,
    ),
    index("projection_settlement_status_retry_idx").on(table.status, table.nextRetryAt),
  ],
);

export const scheduledTasks = sqliteTable(
  "scheduled_task",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt").notNull(),
    recurrence: text("recurrence").notNull(),
    recurrenceFormat: text("recurrence_format").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull(),
    destination: text("destination").notNull(),
    sessionId: text("session_id"),
    projectPathsJson: text("project_paths_json").notNull(),
    executionMode: text("execution_mode").notNull(),
    model: text("model"),
    effort: text("effort"),
    skillNamesJson: text("skill_names_json").notNull(),
    pluginNamesJson: text("plugin_names_json").notNull(),
    permissionProfileJson: text("permission_profile_json").notNull(),
    overlapPolicy: text("overlap_policy").notNull(),
    missedRunPolicy: text("missed_run_policy").notNull(),
    stopPolicyJson: text("stop_policy_json"),
    createdBy: text("created_by").notNull(),
    createdFromSessionId: text("created_from_session_id"),
    lastRunAt: integer("last_run_at"),
    nextRunAt: integer("next_run_at"),
    runCount: integer("run_count").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("scheduled_task_status_next_idx").on(table.status, table.nextRunAt),
    index("scheduled_task_session_idx").on(table.sessionId),
  ],
);

export const scheduledRuns = sqliteTable(
  "scheduled_run",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    cause: text("cause").notNull(),
    status: text("status").notNull(),
    scheduledFor: integer("scheduled_for").notNull(),
    sessionId: text("session_id"),
    runId: text("run_id"),
    summary: text("summary"),
    error: text("error"),
    unread: integer("unread").notNull(),
    attentionReason: text("attention_reason"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("scheduled_run_task_created_idx").on(table.taskId, table.createdAt),
    index("scheduled_run_status_idx").on(table.status),
    index("scheduled_run_unread_idx").on(table.unread, table.createdAt),
  ],
);
