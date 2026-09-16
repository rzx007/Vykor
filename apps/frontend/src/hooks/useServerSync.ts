import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  OpenHarnessClient,
  createPromptRequestId,
  createInitialClientState,
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  syncEvents,
  type CommandCatalogEntry,
  type McpServerStatus,
  type ModelProviderInfo,
  type OpenHarnessClientState,
  type PermissionRequestRecord,
  type PresentationReadRequest,
  type SessionRuntimeConfigPatch,
  type SessionBucket,
  type SessionRecord,
  type SyncEventUpdate,
} from "@openharness/client";

import type { FrontendConfig, McpServerSnapshot, TranscriptItem } from "../types";
import {
  beginJobList,
  mergeJobSnapshot,
  rejectJobList,
  resolveJobList,
  validateJobReadResult,
  validateJobSnapshot,
  validateJobSnapshots,
  type JobDetailRemoteState,
  type JobRemoteState,
} from "../jobs/job-remote-state";
import type { TuiAction, TuiSessionController } from "./sessionController";
import { bucketToTranscript, splitStreamingAssistant } from "./transcript";
import {
  dispatchSessionSlashCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine
} from "./sessionSlashCommands";

const JOBS_AUXILIARY_SLASH_COMMANDS = new Set([
  "/agents",
  "/background",
  "/doctor",
  "/jobs",
  "/stats",
]);

type DisplayRequest = NonNullable<TuiSessionController["displayRequest"]>;
type PresentationCacheEntry = {
  title: string;
  content: string;
  updatedAt: number;
};

const LIVE_TEXT_DELTA_FLUSH_MS = 33;
const PRESENTATION_LOADING_TEXT = "Loading...";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sessionRuntimeMetadata(input: {
  model?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  apiFormat?: unknown;
  permissionMode?: unknown;
  maxTurns?: unknown;
  sessionMode?: unknown;
  pluginsEnabled?: unknown;
}): Record<string, unknown> {
  const runtime: SessionRuntimeConfigPatch = {};
  if (typeof input.model === "string" && input.model) {
    runtime.model = input.model;
  }
  if (typeof input.provider === "string" && input.provider) {
    runtime.provider = input.provider;
  }
  if (typeof input.baseUrl === "string" && input.baseUrl) {
    runtime.baseUrl = input.baseUrl;
  }
  if (input.apiFormat === "anthropic" || input.apiFormat === "openai") {
    runtime.apiFormat = input.apiFormat;
  }
  if (input.permissionMode === "default" || input.permissionMode === "plan" || input.permissionMode === "full_auto") {
    runtime.permissionMode = input.permissionMode;
  }
  if (typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)) {
    runtime.maxTurns = input.maxTurns;
  }
  if (input.sessionMode === "coordinator" || input.sessionMode === "direct") {
    runtime.sessionMode = input.sessionMode;
  }
  if (typeof input.pluginsEnabled === "boolean") {
    runtime.pluginsEnabled = input.pluginsEnabled;
  }
  return patchSessionRuntimeMetadata({}, runtime);
}

function mcpServerSnapshot(server: McpServerStatus): McpServerSnapshot {
  return {
    name: server.name,
    state: server.status,
    ...(server.error || server.command ? { detail: server.error ?? server.command } : {}),
    tool_count: server.toolCount,
    resource_count: server.resourceCount,
  };
}

function normalizeSessionMode(value: unknown): "coordinator" | null {
  return value === "coordinator" ? "coordinator" : null;
}

function statusSessionMode(value: unknown): "coordinator" | "direct" {
  return normalizeSessionMode(value) ?? "direct";
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

type RecoverableRun = {
  id: string;
  error?: string;
  prompt: string;
};

function archiveClientSession(
  state: OpenHarnessClientState,
  sessionId: string,
  archivedAt: number
): OpenHarnessClientState {
  const current = state.sessions[sessionId];
  if (!current || current.status === "archived") return state;
  const archived: SessionRecord = {
    ...current,
    status: "archived",
    archivedAt,
    updatedAt: Math.max(current.updatedAt, archivedAt),
  };
  const bucket = state.buckets[sessionId];
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: archived },
    buckets: bucket
      ? { ...state.buckets, [sessionId]: { ...bucket, session: archived } }
      : state.buckets,
  };
}

function listTopLevelSessions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): SessionRecord[] {
  return [...sessions]
    .filter((session) => !session.parentId && session.status !== "archived")
    .sort((a, b) => {
      if (a.id === activeSessionId) return -1;
      if (b.id === activeSessionId) return 1;
      return b.updatedAt - a.updatedAt;
    });
}

function sessionSelectOptions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): NonNullable<TuiSessionController["selectRequest"]>["options"] {
  return listTopLevelSessions(sessions, activeSessionId).map((session) => ({
    value: session.id,
    label: `${session.id === activeSessionId ? "* " : ""}${session.title || session.id}`,
    description: `${session.model} | ${session.status}`,
  }));
}

export function shouldAutoActivateSession(
  session: SessionRecord,
  defaultModel: string,
  pluginsEnabled: boolean | undefined | null,
): boolean {
  const runtime = readSessionRuntimeConfig(session);
  return runtime.model === defaultModel
    && (pluginsEnabled == null || (runtime.pluginsEnabled ?? true) === pluginsEnabled);
}

function recoverableInterruptedRuns(bucket?: SessionBucket): RecoverableRun[] {
  if (!bucket) return [];
  const recoveredSourceRunIds = new Set(bucket.inputs.flatMap((input) => (isRecord(input.metadata.recovery) && typeof input.metadata.recovery.sourceRunId === "string" ? [input.metadata.recovery.sourceRunId] : [])));
  return Object.values(bucket.runs)
    .filter((run) => run.status === "interrupted" && !!run.inputId && !recoveredSourceRunIds.has(run.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((run) => {
      const input = bucket.inputs.find((candidate) => candidate.id === run.inputId);
      return input ? [{ id: run.id, error: run.error, prompt: input.content }] : [];
    });
}

function shouldCoalesceClientState(update: SyncEventUpdate): boolean {
  return update.source === "live" && update.event?.type === "session.message.part.delta";
}

function permissionToModal(request: PermissionRequestRecord): Record<string, unknown> {
  const input = request.payload.input && typeof request.payload.input === "object" ? (request.payload.input as Record<string, unknown>) : {};
  return {
    kind: "permission",
    request_id: request.id,
    tool_name: request.toolName,
    reason: typeof request.payload.reason === "string" ? request.payload.reason : null,
    input,
  };
}

function firstPendingPermission(state: OpenHarnessClientState, sessionId?: string): PermissionRequestRecord | undefined {
  if (!sessionId) return undefined;
  const bucket = state.buckets[sessionId];
  if (!bucket) return undefined;
  return Object.values(bucket.permissions)
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(0);
}

export function useServerSync(config: FrontendConfig, onError?: (message: string) => void): TuiSessionController {
  const daemon = config.daemon;
  const [clientState, setClientState] = useState<OpenHarnessClientState>(() => createInitialClientState());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [status, setStatus] = useState<Record<string, unknown>>({
    permission_mode: daemon?.permissionMode ?? "default",
    model: daemon?.model ?? "default",
    session_mode: statusSessionMode(daemon?.sessionMode),
    ...(typeof daemon?.maxTurns === "number" ? { max_turns: daemon.maxTurns } : {}),
  });
  const [modal, setModal] = useState<Record<string, unknown> | null>(null);
  const [selectRequest, setSelectRequest] = useState<TuiSessionController["selectRequest"]>(null);
  const [displayRequest, setDisplayRequest] = useState<TuiSessionController["displayRequest"]>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [submittedRun, setSubmittedRun] = useState<{
    sessionId: string;
    runId: string;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [globalSystemItems, setGlobalSystemItems] = useState<TranscriptItem[]>([]);
  const [systemItemsBySession, setSystemItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogEntry[]>([]);
  const [jobState, setJobState] = useState<JobRemoteState>({ status: "idle", jobs: [] });
  const [jobDetailState, setJobDetailState] = useState<JobDetailRemoteState>({ status: "idle" });
  const [mcpServers, setMcpServers] = useState<McpServerSnapshot[]>([]);
  const clientRef = useRef<OpenHarnessClient | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const commandCatalogRef = useRef<CommandCatalogEntry[]>([]);
  const defaultRuntimeRef = useRef<{
    model: string;
    provider?: string;
    baseUrl?: string;
    apiFormat?: "anthropic" | "openai";
  }>({
    model: daemon?.model ?? "default",
  });
  const nextSessionModeRef = useRef<"coordinator" | "direct">(statusSessionMode(daemon?.sessionMode));
  const statusRef = useRef(status);
  const sentInitialPromptRef = useRef(false);
  const pendingNewSessionTitleRef = useRef<string | undefined>(undefined);
  const listedSessionsRef = useRef<Record<string, SessionRecord>>({});
  const presentationCacheRef = useRef<Record<string, PresentationCacheEntry>>({});
  const displayRequestRef = useRef<TuiSessionController["displayRequest"]>(null);
  const pendingClientStateRef = useRef<OpenHarnessClientState | null>(null);
  const pendingClientStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownPermissionIdRef = useRef<string | undefined>(undefined);
  const auxiliaryGenerationRef = useRef(0);
  const jobStateRef = useRef(jobState);
  const jobDetailStateRef = useRef(jobDetailState);
  const jobGenerationRef = useRef(0);
  const jobDetailGenerationRef = useRef(0);
  const jobsAbortRef = useRef<AbortController | null>(null);
  const jobDetailAbortRef = useRef<AbortController | null>(null);
  const jobControlAbortRef = useRef<AbortController | null>(null);
  const jobControlGenerationRef = useRef(0);
  const mcpAbortRef = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    commandCatalogRef.current = commandCatalog;
  }, [commandCatalog]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    displayRequestRef.current = displayRequest;
  }, [displayRequest]);

  useEffect(() => {
    jobStateRef.current = jobState;
  }, [jobState]);

  useEffect(() => {
    jobDetailStateRef.current = jobDetailState;
  }, [jobDetailState]);

  const clearDisplayRequest = useCallback(() => {
    displayRequestRef.current = null;
    setDisplayRequest(null);
  }, []);

  const showDisplayRequest = useCallback((request: DisplayRequest) => {
    displayRequestRef.current = request;
    setSelectRequest(null);
    setDisplayRequest(request);
  }, []);

  const clearAuxiliaryState = useCallback((): void => {
    auxiliaryGenerationRef.current += 1;
    jobGenerationRef.current += 1;
    jobDetailGenerationRef.current += 1;
    jobControlGenerationRef.current += 1;
    mcpAbortRef.current?.abort();
    jobsAbortRef.current?.abort();
    jobDetailAbortRef.current?.abort();
    jobControlAbortRef.current?.abort();
    mcpAbortRef.current = null;
    jobsAbortRef.current = null;
    jobDetailAbortRef.current = null;
    jobControlAbortRef.current = null;
    const emptyJobState: JobRemoteState = { status: "idle", jobs: [] };
    const emptyJobDetailState: JobDetailRemoteState = { status: "idle" };
    jobStateRef.current = emptyJobState;
    jobDetailStateRef.current = emptyJobDetailState;
    setJobState(emptyJobState);
    setJobDetailState(emptyJobDetailState);
    setMcpServers([]);
  }, []);

  const setStatusAndDefault = useCallback((value: SetStateAction<Record<string, unknown>>) => {
    setStatus((current) => {
      const next = typeof value === "function" ? value(current) : value;
      if (typeof next.model === "string" && !activeSessionIdRef.current) {
        defaultRuntimeRef.current = {
          ...defaultRuntimeRef.current,
          model: next.model,
          ...(typeof next.provider === "string" ? { provider: next.provider } : {}),
          ...(typeof next.baseUrl === "string" ? { baseUrl: next.baseUrl } : {}),
          ...(next.apiFormat === "anthropic" || next.apiFormat === "openai" ? { apiFormat: next.apiFormat } : {}),
        };
      }
      return next;
    });
  }, []);

  const pushSystem = useCallback((text: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setGlobalSystemItems((items) => [...items, { role: "system", text }]);
      return;
    }
    setSystemItemsBySession((itemsBySession) => ({
      ...itemsBySession,
      [sessionId]: [...(itemsBySession[sessionId] ?? []), { role: "system", text }],
    }));
  }, []);

  const reportError = useCallback(
    (message: string) => {
    pushSystem(`error: ${message}`);
    onErrorRef.current?.(message);
    setLocalBusy(false);
    setSubmittedRun(null);
    },
    [pushSystem],
  );

  const reportAuxiliaryError = useCallback((scope: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    onErrorRef.current?.(`${scope}: ${message}`);
  }, []);

  const refreshJobs = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const sessionId = activeSessionIdRef.current;
    const generation = ++jobGenerationRef.current;
    if (!client || !sessionId) {
      const idle: JobRemoteState = { status: "idle", jobs: [] };
      jobStateRef.current = idle;
      setJobState(idle);
      return;
    }

    jobsAbortRef.current?.abort();
    const controller = new AbortController();
    jobsAbortRef.current = controller;
    setJobState((current) => {
      const next = beginJobList(current);
      jobStateRef.current = next;
      return next;
    });

    try {
      const response = await client.listJobs({
        sessionId,
        includeFinished: true,
        limit: 100,
        signal: controller.signal,
      });
      if (activeSessionIdRef.current !== sessionId || jobGenerationRef.current !== generation) return;
      const validated = validateJobSnapshots(response, sessionId);
      if (validated.error) {
        const validationError = validated.error;
        const now = Date.now();
        setJobState((current) => {
          const next: JobRemoteState = validated.jobs.length > 0
            ? {
                ...resolveJobList(validated.jobs, now, current),
                status: "error",
                error: validationError,
              }
            : rejectJobList(current, validationError);
          jobStateRef.current = next;
          return next;
        });
        reportAuxiliaryError("Jobs", validationError);
      } else {
        const next = resolveJobList(validated.jobs, Date.now(), jobStateRef.current);
        jobStateRef.current = next;
        setJobState(next);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (activeSessionIdRef.current !== sessionId || jobGenerationRef.current !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      setJobState((current) => {
        const next = rejectJobList(current, message);
        jobStateRef.current = next;
        return next;
      });
      reportAuxiliaryError("Jobs", message);
    } finally {
      if (jobsAbortRef.current === controller) jobsAbortRef.current = null;
    }
  }, [reportAuxiliaryError]);

  const loadJobDetail = useCallback(async (
    client: OpenHarnessClient,
    sessionId: string,
    jobId: string,
  ): Promise<void> => {
    const generation = ++jobDetailGenerationRef.current;
    jobDetailAbortRef.current?.abort();
    const controller = new AbortController();
    jobDetailAbortRef.current = controller;
    const current = jobDetailStateRef.current;
    const previous = current.status !== "idle" && current.jobId === jobId
      ? current.status === "ready"
        ? current.result
        : current.previous
      : undefined;
    const loading: JobDetailRemoteState = {
      status: "loading",
      jobId,
      ...(previous ? { previous } : {}),
    };
    jobDetailStateRef.current = loading;
    setJobDetailState(loading);

    try {
      const response = await client.readJob(jobId, {
        sessionId,
        signal: controller.signal,
      });
      if (activeSessionIdRef.current !== sessionId || jobDetailGenerationRef.current !== generation) return;
      const validated = validateJobReadResult(response, sessionId, jobId);
      if (!validated.result) {
        throw new Error(validated.error ?? `Job read response for "${jobId}" has invalid fields.`);
      }
      const result = validated.result;
      const readyState: JobDetailRemoteState = {
        status: "ready",
        jobId,
        result,
        refreshedAt: Date.now(),
      };
      jobDetailStateRef.current = readyState;
      setJobDetailState(readyState);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (activeSessionIdRef.current !== sessionId || jobDetailGenerationRef.current !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      const errorState: JobDetailRemoteState = {
        status: "error",
        jobId,
        error: message,
        ...(previous ? { previous } : {}),
      };
      jobDetailStateRef.current = errorState;
      setJobDetailState(errorState);
      reportAuxiliaryError("Jobs", message);
    } finally {
      if (jobDetailAbortRef.current === controller) jobDetailAbortRef.current = null;
    }
  }, [reportAuxiliaryError]);

  const loadModels = useCallback(async (): Promise<ModelProviderInfo[]> => {
    const client = clientRef.current;
    if (!client) return [];
    return await client.listModels();
  }, []);

  const cacheFirstRead = useCallback(
    (request: PresentationReadRequest): void => {
    const cached = presentationCacheRef.current[request.key];
    showDisplayRequest({
      key: request.key,
      title: request.title,
      content: cached?.content ?? PRESENTATION_LOADING_TEXT,
    });

      void request
        .load()
      .then((content) => {
        presentationCacheRef.current = {
          ...presentationCacheRef.current,
          [request.key]: {
            title: request.title,
            content,
            updatedAt: Date.now(),
          },
        };
        if (displayRequestRef.current?.key !== request.key) return;
        showDisplayRequest({
          key: request.key,
          title: request.title,
          content,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
          const content = cached ? `${cached.content}\n\nRefresh failed: ${message}` : `Failed to load ${request.title}: ${message}`;
        if (displayRequestRef.current?.key !== request.key) return;
        showDisplayRequest({
          key: request.key,
          title: request.title,
          content,
        });
      });
    },
    [showDisplayRequest],
  );

  const clearPendingClientState = useCallback(() => {
    if (pendingClientStateTimerRef.current) {
      clearTimeout(pendingClientStateTimerRef.current);
      pendingClientStateTimerRef.current = null;
    }
    pendingClientStateRef.current = null;
  }, []);

  const commitClientState = useCallback(
    (state: OpenHarnessClientState, coalesce: boolean) => {
    if (!coalesce) {
      clearPendingClientState();
      setClientState(state);
      return;
    }

    pendingClientStateRef.current = state;
    if (pendingClientStateTimerRef.current) return;
    pendingClientStateTimerRef.current = setTimeout(() => {
      pendingClientStateTimerRef.current = null;
      const pending = pendingClientStateRef.current;
      pendingClientStateRef.current = null;
      if (pending) setClientState(pending);
    }, LIVE_TEXT_DELTA_FLUSH_MS);
    },
    [clearPendingClientState],
  );

  useEffect(() => clearPendingClientState, [clearPendingClientState]);

  const activateSession = useCallback(
    (session: SessionRecord): void => {
    const runtime = readSessionRuntimeConfig(session, defaultRuntimeRef.current);
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
      clearAuxiliaryState();
    setStatus((current) => ({
      ...current,
      model: runtime.model,
      ...(runtime.provider ? { provider: runtime.provider } : {}),
      session_id: session.id,
      cwd: session.cwd,
        permission_mode: typeof runtime.permissionMode === "string" ? runtime.permissionMode : current.permission_mode,
        ...(typeof runtime.maxTurns === "number" ? { max_turns: runtime.maxTurns } : {}),
      session_mode: statusSessionMode(runtime.sessionMode),
    }));
    },
    [clearAuxiliaryState],
  );

  const returnToHome = useCallback(
    (title?: string): void => {
    pendingNewSessionTitleRef.current = title?.trim() || undefined;
    activeSessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    clearAuxiliaryState();
    setLocalBusy(false);
    setSubmittedRun(null);
    setSelectRequest(null);
    clearDisplayRequest();
    setModal(null);
    setStatus((current) => {
      const next = { ...current };
      delete next.session_id;
      next.model = defaultRuntimeRef.current.model;
      if (defaultRuntimeRef.current.provider) next.provider = defaultRuntimeRef.current.provider;
      else delete next.provider;
      next.session_mode = nextSessionModeRef.current;
      return next;
    });
    },
    [clearAuxiliaryState, clearDisplayRequest],
  );

  useEffect(() => {
    if (!daemon?.url) {
      setReady(true);
      reportError("Daemon URL is required for TUI. Launch with `ohs` or `ohs --tui` so the CLI can start or attach the daemon.");
      return;
    }
    let cancelled = false;
    const client = new OpenHarnessClient({
      baseUrl: daemon.url,
      token: daemon.token ?? undefined,
    });
    clientRef.current = client;

    void (async () => {
      try {
        await client.health();
        const cwd = daemon.cwd ?? process.cwd();
        const [settings, sessions, commands] = await Promise.all([client.getSettings().catch(() => ({}) as Record<string, unknown>), client.listSessions({ cwd, limit: 20 }), client.listCommands({ cwd }).catch(() => [] as CommandCatalogEntry[])]);
        const model = daemon.model ?? stringSetting(settings.model) ?? "default";
        const provider = stringSetting(settings.provider);
        const baseUrl = stringSetting(settings.baseUrl);
        const apiFormat = settings.apiFormat === "anthropic" || settings.apiFormat === "openai" ? settings.apiFormat : undefined;
        defaultRuntimeRef.current = {
          model,
          ...(provider ? { provider } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiFormat ? { apiFormat } : {}),
        };
        if (cancelled) return;
        listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
        setCommandCatalog(commands);
        setStatus((current) => ({
          ...current,
          model,
          ...(provider ? { provider } : {}),
          cwd,
          permission_mode: daemon?.permissionMode ?? current.permission_mode,
          ...(typeof daemon?.maxTurns === "number" ? { max_turns: daemon.maxTurns } : {}),
          session_mode: statusSessionMode(daemon?.sessionMode),
        }));
        const session = sessions[0];
        if (session && shouldAutoActivateSession(session, model, daemon?.pluginsEnabled)) {
          activateSession(session);
          void client.getSession(session.id).catch(() => {});
        }
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setReady(true);
        reportError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      clientRef.current = null;
    };
  }, [activateSession, daemon?.cwd, daemon?.maxTurns, daemon?.model, daemon?.permissionMode, daemon?.pluginsEnabled, daemon?.sessionMode, daemon?.token, daemon?.url, reportError]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !activeSessionId) return;
    const controller = new AbortController();

    void (async () => {
      let reconnectNotice = false;
      try {
        for await (const update of syncEvents(client, {
          sessionId: activeSessionId,
          signal: controller.signal,
        })) {
          if (update.source === "reconnecting") {
            if (!reconnectNotice) {
              reconnectNotice = true;
              pushSystem("reconnecting...");
            }
            continue;
          }
          if (reconnectNotice) reconnectNotice = false;
          commitClientState(update.state, shouldCoalesceClientState(update));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        reportError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      clearPendingClientState();
      controller.abort();
    };
  }, [activeSessionId, clearPendingClientState, commitClientState, pushSystem, reportError]);

  useEffect(() => {
    const client = clientRef.current;
    const sessionId = activeSessionId;
    if (!client || !sessionId) return;
    const generation = ++auxiliaryGenerationRef.current;
    mcpAbortRef.current?.abort();
    const controller = new AbortController();
    mcpAbortRef.current = controller;
    const isCurrent = () => activeSessionIdRef.current === sessionId && auxiliaryGenerationRef.current === generation;

    void client.getSessionMcp(sessionId, { signal: controller.signal })
      .then((servers) => {
        if (!isCurrent()) return;
        setMcpServers(Array.isArray(servers) ? servers.map(mcpServerSnapshot) : []);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (!isCurrent()) return;
        setMcpServers([]);
        reportAuxiliaryError("MCP", error);
      })
      .finally(() => {
        if (mcpAbortRef.current === controller) mcpAbortRef.current = null;
      });

    return () => {
      controller.abort();
    };
  }, [activeSessionId, reportAuxiliaryError]);

  useEffect(() => {
    jobDetailGenerationRef.current += 1;
    jobDetailAbortRef.current?.abort();
    jobDetailAbortRef.current = null;
    const idle: JobDetailRemoteState = { status: "idle" };
    jobDetailStateRef.current = idle;
    setJobDetailState(idle);
    void refreshJobs();
    return () => {
      jobsAbortRef.current?.abort();
    };
  }, [activeSessionId, refreshJobs]);

  useEffect(() => {
    const pending = firstPendingPermission(clientState, activeSessionId);
    if (!pending) {
      shownPermissionIdRef.current = undefined;
      if (modal?.kind === "permission") setModal(null);
      return;
    }
    if (shownPermissionIdRef.current === pending.id) return;
    shownPermissionIdRef.current = pending.id;
    setModal(permissionToModal(pending));
  }, [activeSessionId, clientState, modal?.kind]);

  const running = hasActiveRun(clientState, activeSessionId);
  useEffect(() => {
    if (!submittedRun) return;
    const run = clientState.buckets[submittedRun.sessionId]?.runs[submittedRun.runId];
    if (!run || run.status === "pending" || run.status === "running") return;
    void refreshJobs();
    if (run.status === "failed") {
      reportError(run.error ?? "Agent run failed");
      return;
    }
    setSubmittedRun(null);
  }, [clientState, refreshJobs, reportError, submittedRun]);

  const createAndSwitchSession = useCallback(
    async (title?: string): Promise<SessionRecord | undefined> => {
    const client = clientRef.current;
    if (!client) return undefined;
    setLocalBusy(true);
    const cwd = daemon?.cwd ?? process.cwd();
    const model = defaultRuntimeRef.current.model;
    const metadata = sessionRuntimeMetadata({
      model,
      provider: defaultRuntimeRef.current.provider,
      baseUrl: defaultRuntimeRef.current.baseUrl,
      apiFormat: defaultRuntimeRef.current.apiFormat,
      permissionMode: statusRef.current.permission_mode ?? daemon?.permissionMode ?? "default",
      maxTurns: statusRef.current.max_turns ?? daemon?.maxTurns,
      sessionMode: nextSessionModeRef.current,
      pluginsEnabled: daemon?.pluginsEnabled,
    });
    const session = await client.sessions.create({
      cwd,
      model,
      title: title?.trim() || "TUI",
      metadata,
    });
    activateSession(session);
    setSelectRequest(null);
    setLocalBusy(false);
    setSubmittedRun(null);
    pendingNewSessionTitleRef.current = undefined;
    return session;
    },
    [activateSession, daemon?.cwd, daemon?.maxTurns, daemon?.model, daemon?.permissionMode, daemon?.pluginsEnabled, daemon?.sessionMode],
  );

  useEffect(() => {
    if (!ready || sentInitialPromptRef.current || !config.initial_prompt) return;
    sentInitialPromptRef.current = true;
    const client = clientRef.current;
    if (!client) return;
    setLocalBusy(true);
    void (async () => {
      const session = activeSessionId ? (clientState.sessions[activeSessionId] ?? (await client.getSession(activeSessionId))) : await createAndSwitchSession();
      if (!session) {
        setLocalBusy(false);
        return;
      }
      const response = await client.sessions.admitPrompt(session.id, {
        id: createPromptRequestId(),
        items: [{ type: "text", text: config.initial_prompt! }],
      });
      setLocalBusy(false);
      setSubmittedRun(response.run ? { sessionId: session.id, runId: response.run.id } : null);
    })().catch((error) => reportError(error instanceof Error ? error.message : String(error)));
  }, [activeSessionId, clientState.sessions, config.initial_prompt, createAndSwitchSession, ready, reportError]);

  const sendRequest = useCallback(
    (action: TuiAction): void => {
    const client = clientRef.current;
    let sessionId = activeSessionIdRef.current;

    void (async () => {
        const runtimeAction = action as TuiAction | { type?: unknown };
        const runtimeType = typeof runtimeAction.type === "string" ? runtimeAction.type : "unknown";
        switch (action.type) {
          case "select_model": {
            if (!client) return;
            const model = action.model.trim();
            const provider = action.provider?.trim() ?? "";
        if (!model) return;

        if (sessionId) {
          const session = await client.updateSession(sessionId, {
                metadata: patchSessionRuntimeMetadata(
                  {},
                  {
              model,
              ...(provider ? { provider } : {}),
                  },
                ),
          });
          activateSession(session);
        } else {
          const settingsPatch: Record<string, unknown> = { model };
          if (provider) settingsPatch.provider = provider;
          await client.patchSettings(settingsPatch);
          defaultRuntimeRef.current = {
            ...defaultRuntimeRef.current,
            model,
            ...(provider ? { provider } : {}),
          };
          setStatus((current) => ({
            ...current,
            model,
            ...(provider ? { provider } : {}),
          }));
        }
        pushSystem(`Model selected: ${model}`);
        return;
      }

          case "submit_line": {
            if (!client) return;
            const line = action.line;
        const slash = parseSlashLine(line);

        const newSession = line.match(/^\/new(?:\s+(.+))?$/);
        if (newSession) {
          returnToHome(newSession[1]);
          return;
        }
        const switchSession = line.match(/^\/sessions\s+open\s+(.+)$/);
        if (switchSession?.[1]) {
          const target = switchSession[1].trim();
          setLocalBusy(false);
          setSubmittedRun(null);
          pendingNewSessionTitleRef.current = undefined;
          setSelectRequest(null);
          const knownSession = clientState.sessions[target] ?? listedSessionsRef.current[target];
          if (knownSession) {
            activateSession(knownSession);
            return;
          }
          const session = await client.getSession(target);
          activateSession(session);
          return;
        }

        if (slash?.name === "/resume") {
          if (!sessionId) {
            pushSystem("No active session to resume.");
            return;
          }
          const recoverable = recoverableInterruptedRuns(clientState.buckets[sessionId]);
          if (!slash.args) {
            if (recoverable.length === 0) {
              pushSystem("No interrupted prompt runs are available to resume.");
              return;
            }
            clearDisplayRequest();
            setSelectRequest({
              title: "Resume interrupted run",
              submitPrefix: "/resume ",
              options: recoverable.map((run) => ({
                value: run.id,
                label: run.prompt.length > 72 ? `${run.prompt.slice(0, 72)}...` : run.prompt,
                description: run.error ?? "Interrupted before completion",
              })),
            });
            return;
          }
          const runId = slash.args.trim();
          if (!recoverable.some((run) => run.id === runId)) {
            pushSystem(`Run is not available for recovery: ${runId}`);
            return;
          }
          setLocalBusy(true);
          const response = await client.resumeInterruptedRun(sessionId, runId, { id: createPromptRequestId() });
          setLocalBusy(false);
          setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
          setSelectRequest(null);
          return;
        }

        let slashResult: Awaited<ReturnType<typeof dispatchSessionSlashCommand>>;
        try {
          slashResult = await dispatchSessionSlashCommand(slash, {
            client,
            sessionId,
            pushSystem,
            presentSystem: (title, content) => showDisplayRequest({ title, content }),
            statusRef,
            commandCatalogRef,
            clientState,
            localBusy,
            cacheFirstRead,
            daemon,
            setStatus: setStatusAndDefault,
          });
        } catch (error) {
          if (slash && JOBS_AUXILIARY_SLASH_COMMANDS.has(slash.name)) {
            reportAuxiliaryError("Jobs", error);
            return;
          }
          throw error;
        }
        if (slashResult === "handled") {
          if (slash?.name === "/background" && slash.args.trim() && sessionId) {
            await refreshJobs();
          }
          return;
        }
        if (slashResult === "local_ui_ignored") return;

        if (slash) {
          const catalogEntry = commandCatalogRef.current.find((entry) => entry.name === slash.name);
          if (catalogEntry?.kind === "template") {
            if (!sessionId) return;
            setLocalBusy(true);
            const response = await client.sessions.admitPrompt(sessionId, {
              id: createPromptRequestId(),
              items: [
                {
                  type: "skill",
                  name: catalogEntry.skillName,
                  path: catalogEntry.path,
                  ...(catalogEntry.displayName ? { displayName: catalogEntry.displayName } : {}),
                  ...(catalogEntry.source && catalogEntry.source !== "builtin" ? { source: catalogEntry.source } : {}),
                },
                ...(slash.args ? [{ type: "text" as const, text: ` ${slash.args}` }] : []),
              ],
            });
            setLocalBusy(false);
            setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
            return;
          }
          pushSystem(`Unknown command: ${slash.name}`);
          return;
        }

        if (!sessionId) {
          const session = await createAndSwitchSession(pendingNewSessionTitleRef.current);
          if (!session) return;
          sessionId = session.id;
        }
        setLocalBusy(true);
            const response = await client.sessions.admitPrompt(sessionId, {
              id: createPromptRequestId(),
              items: [{ type: "text", text: line }],
            });
        setLocalBusy(false);
        setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
        return;
      }

          case "delete_session": {
            if (!client) return;
            const target = action.session_id;
        if (!target) return;
        const archived = await client.archiveSession(target);
        const archivedAt = archived.archivedAt ?? Date.now();
        delete listedSessionsRef.current[target];
        setClientState((current) => archiveClientSession(current, target, archivedAt));
        setLocalBusy(false);
        setSubmittedRun(null);
            setSelectRequest((current) =>
              current
                ? {
                    ...current,
                    options: current.options.filter((option) => option.value !== target),
                  }
                : current,
            );
        if (target === activeSessionIdRef.current) {
          const remaining = listTopLevelSessions(
            Object.values({
              ...clientState.sessions,
              ...listedSessionsRef.current,
              [target]: { ...archived, status: "archived", archivedAt },
            }),
          );
          if (remaining[0]) {
            activateSession(remaining[0]);
          } else {
            const sessions = await client.listSessions({
              cwd: daemon?.cwd ?? undefined,
              includeArchived: false,
              limit: 20,
            });
            listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
            const remoteNext = sessions.find((session) => session.id !== target);
            if (remoteNext) activateSession(remoteNext);
            else returnToHome();
          }
        }
        return;
      }

          case "interrupt": {
            if (!client) return;
        if (sessionId) await client.interruptSession(sessionId);
        setLocalBusy(false);
        setSubmittedRun(null);
        return;
      }

          case "permission_response": {
            if (!client) return;
            const requestId = action.request_id;
            const allowed = action.allowed;
        await client.replyPermission(requestId, {
          status: allowed ? "approved" : "denied",
              decision: action.scope === "session" ? "session" : "once",
          clientId: "tui",
        });
        setModal(null);
        return;
      }

          case "list_sessions": {
            if (!client) return;
        const cachedSessions = {
          ...listedSessionsRef.current,
          ...clientState.sessions,
        };
            const cachedOptions = sessionSelectOptions(Object.values(cachedSessions), activeSessionIdRef.current);
        clearDisplayRequest();
        setSelectRequest({
          title: "Sessions",
          submitPrefix: "/sessions open ",
          options: cachedOptions,
        });
        const sessions = await client.listSessions({
          cwd: daemon?.cwd ?? undefined,
          includeArchived: false,
          limit: 20,
        });
        listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
            setSelectRequest((current) =>
              current?.submitPrefix === "/sessions open "
          ? {
              title: "Sessions",
              submitPrefix: "/sessions open ",
              options: sessionSelectOptions(sessions, activeSessionIdRef.current),
            }
                : current,
            );
        return;
      }

          case "set_permission_mode": {
            if (!client) return;
            const mode = action.permission_mode;
        setStatus((current) => ({ ...current, permission_mode: mode }));
        if (sessionId) {
          await client.updateSession(sessionId, {
            metadata: patchSessionRuntimeMetadata({}, { permissionMode: mode }),
          });
        }
        return;
      }

          case "question_response": {
            if (!client) return;
            reportError("Interactive question responses are not available through the daemon client.");
            return;
          }

          case "set_session_mode": {
            if (!client) return;
        if (sessionId) {
          pushSystem("Coordinator mode can only be changed before starting a new session. Use /new first.");
          return;
        }
            const mode = normalizeSessionMode(action.session_mode);
        nextSessionModeRef.current = statusSessionMode(mode);
            setStatus((current) => ({
              ...current,
              session_mode: nextSessionModeRef.current,
            }));
            return;
          }

          case "job_request": {
            if (!client) {
              reportAuxiliaryError("Jobs", "The daemon client is not connected.");
              return;
            }
            const currentSessionId = activeSessionIdRef.current;
            if (!currentSessionId) return;
            try {
              switch (action.job_action) {
                case "open":
                  await refreshJobs();
                  return;
                case "refresh": {
                  jobControlGenerationRef.current += 1;
                  jobControlAbortRef.current?.abort();
                  jobControlAbortRef.current = null;
                  const detail = jobDetailStateRef.current;
                  const detailJobId = detail.status === "idle" ? undefined : detail.jobId;
                  await Promise.all([
                    refreshJobs(),
                    detailJobId
                      ? loadJobDetail(client, currentSessionId, detailJobId)
                      : Promise.resolve(),
                  ]);
                  return;
                }
                case "select":
                  jobControlGenerationRef.current += 1;
                  jobControlAbortRef.current?.abort();
                  jobControlAbortRef.current = null;
                  await loadJobDetail(client, currentSessionId, action.job_id);
                  return;
                case "cancel": {
                  const controlGeneration = ++jobControlGenerationRef.current;
                  const detailGeneration = jobDetailGenerationRef.current;
                  jobControlAbortRef.current?.abort();
                  const controller = new AbortController();
                  jobControlAbortRef.current = controller;
                  let response: Awaited<ReturnType<OpenHarnessClient["cancelJob"]>>;
                  try {
                    response = await client.cancelJob(
                      action.job_id,
                      {
                        sessionId: currentSessionId,
                        reason: action.reason,
                      },
                      { signal: controller.signal },
                    );
                  } catch (error) {
                    if (activeSessionIdRef.current !== currentSessionId) return;
                    if (controller.signal.aborted || jobControlGenerationRef.current !== controlGeneration) {
                      await refreshJobs();
                      return;
                    }
                    throw error;
                  } finally {
                    if (jobControlAbortRef.current === controller) jobControlAbortRef.current = null;
                  }
                  if (activeSessionIdRef.current !== currentSessionId) return;
                  const ownsDetail = !controller.signal.aborted &&
                    jobControlGenerationRef.current === controlGeneration &&
                    jobDetailGenerationRef.current === detailGeneration;
                  const validated = validateJobSnapshot(response, currentSessionId, action.job_id);
                  if (!validated.snapshot) {
                    if (controller.signal.aborted || jobControlGenerationRef.current !== controlGeneration) {
                      await refreshJobs();
                      return;
                    }
                    throw new Error(validated.error ?? "Job snapshot has invalid fields.");
                  }
                  const snapshot = validated.snapshot;
                  const next = mergeJobSnapshot(jobStateRef.current, snapshot, Date.now());
                  jobStateRef.current = next;
                  setJobState(next);
                  if (ownsDetail) {
                    await loadJobDetail(client, currentSessionId, action.job_id);
                  }
                  await refreshJobs();
                  return;
                }
                case "send": {
                  const controlGeneration = ++jobControlGenerationRef.current;
                  const detailGeneration = jobDetailGenerationRef.current;
                  jobControlAbortRef.current?.abort();
                  const controller = new AbortController();
                  jobControlAbortRef.current = controller;
                  try {
                    await client.sendJob(
                      action.job_id,
                      {
                        sessionId: currentSessionId,
                        data: action.data,
                      },
                      { signal: controller.signal },
                    );
                  } catch (error) {
                    if (activeSessionIdRef.current !== currentSessionId) return;
                    if (controller.signal.aborted || jobControlGenerationRef.current !== controlGeneration) {
                      await refreshJobs();
                      return;
                    }
                    throw error;
                  } finally {
                    if (jobControlAbortRef.current === controller) jobControlAbortRef.current = null;
                  }
                  if (activeSessionIdRef.current !== currentSessionId) return;
                  const ownsDetail = !controller.signal.aborted &&
                    jobControlGenerationRef.current === controlGeneration &&
                    jobDetailGenerationRef.current === detailGeneration;
                  if (ownsDetail) {
                    await loadJobDetail(client, currentSessionId, action.job_id);
                  }
                  await refreshJobs();
                  return;
                }
              }
            } catch (error) {
              reportAuxiliaryError("Jobs", error);
              return;
            }
          }

          default: {
            const exhaustive: never = action;
            void exhaustive;
            reportError(`Unsupported TUI action: ${runtimeType}`);
            return;
          }
        }
    })().catch((error) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
    },
    [activeSessionId, activateSession, cacheFirstRead, clearDisplayRequest, clientState, createAndSwitchSession, daemon, loadJobDetail, localBusy, pushSystem, refreshJobs, reportAuxiliaryError, reportError, returnToHome, showDisplayRequest],
  );

  const bucket = activeSessionId ? clientState.buckets[activeSessionId] : undefined;
  const recoveryItems = useMemo(
    () =>
      recoverableInterruptedRuns(bucket).map((run) => ({
      id: `recovery:${run.id}`,
      role: "system" as const,
      text: `Run interrupted${run.error ? `: ${run.error}` : ""}\nUse /resume ${run.id} to replay its original prompt.`,
    })),
    [bucket],
  );
  const transcriptView = useMemo(() => {
    const base = splitStreamingAssistant(bucketToTranscript(bucket));
    return {
      transcript: [...base.items, ...recoveryItems, ...(activeSessionId ? (systemItemsBySession[activeSessionId] ?? []) : globalSystemItems)],
      assistantBuffer: base.assistantBuffer,
    };
  }, [activeSessionId, bucket, globalSystemItems, recoveryItems, systemItemsBySession]);
  const submittedRunRecord = submittedRun ? clientState.buckets[submittedRun.sessionId]?.runs[submittedRun.runId] : undefined;
  const waitingForSubmittedRun = !!submittedRun && (!submittedRunRecord || submittedRunRecord.status === "pending" || submittedRunRecord.status === "running");
  const commandDetails = useMemo(() => mergeCommandDetails(commandCatalog), [commandCatalog]);
  const commands = useMemo(() => commandDetails.map((entry) => entry.name), [commandDetails]);

  return useMemo(
    () => ({
      transcript: transcriptView.transcript,
      assistantBuffer: transcriptView.assistantBuffer,
      status,
      jobState,
      jobs: jobState.jobs,
      jobDetailState,
      commands,
      commandDetails,
      mcpServers,
      modal,
      selectRequest,
      displayRequest,
      busy: localBusy || running || waitingForSubmittedRun,
      ready,
      setModal,
      setSelectRequest,
      setDisplayRequest,
      setBusy: setLocalBusy,
      loadModels,
      sendRequest,
    }),
    [commandDetails, commands, displayRequest, jobDetailState, jobState, loadModels, localBusy, mcpServers, modal, ready, running, selectRequest, sendRequest, status, transcriptView, waitingForSubmittedRun],
  );
}
