import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  OpenHarnessClient,
  SessionSyncController,
  createPromptRequestId,
  createInitialClientState,
  readSessionRuntimeConfig,
  type CommandCatalogEntry,
  type ModelProviderInfo,
  type OpenHarnessClientState,
  type PresentationReadRequest,
  type SessionRecord,
} from "@openharness/client";

import type { FrontendConfig, McpServerSnapshot, TranscriptItem } from "../types";
import {
  beginJobList,
  rejectJobList,
  resolveJobList,
  validateJobReadResult,
  validateJobSnapshots,
  type JobDetailRemoteState,
  type JobRemoteState,
} from "../jobs/job-remote-state";
import type { TuiAction, TuiSessionController } from "./sessionController";
import { bucketToTranscript, splitStreamingAssistant } from "./transcript";
import {
  hasActiveRun,
  mergeCommandDetails,
} from "./sessionSlashCommands";
import {
  createDaemonClient,
  executeTuiAction,
  firstPendingPermission,
  mcpServerSnapshot,
  permissionToModal,
  recoverableInterruptedRuns,
  sessionRuntimeMetadata,
  shouldAutoActivateSession,
  shouldCoalesceClientState,
  statusSessionMode,
  stringSetting,
  type DefaultRuntimeSettings,
} from "./sync-submodules";

export { sessionRuntimeMetadata, shouldAutoActivateSession } from "./sync-submodules";

type DisplayRequest = NonNullable<TuiSessionController["displayRequest"]>;
type PresentationCacheEntry = {
  title: string;
  content: string;
  updatedAt: number;
};

const LIVE_TEXT_DELTA_FLUSH_MS = 33;
const PRESENTATION_LOADING_TEXT = "Loading...";

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
  const [showReasoning, setShowReasoning] = useState(true);
  const [globalSystemItems, setGlobalSystemItems] = useState<TranscriptItem[]>([]);
  const [systemItemsBySession, setSystemItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogEntry[]>([]);
  const [jobState, setJobState] = useState<JobRemoteState>({ status: "idle", jobs: [] });
  const [jobDetailState, setJobDetailState] = useState<JobDetailRemoteState>({ status: "idle" });
  const [mcpServers, setMcpServers] = useState<McpServerSnapshot[]>([]);

  const clientRef = useRef<OpenHarnessClient | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const commandCatalogRef = useRef<CommandCatalogEntry[]>([]);
  const defaultRuntimeRef = useRef<DefaultRuntimeSettings>({
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
  const syncGenerationRef = useRef(0);
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
      const response = await client.jobs.list({
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
    client: Pick<OpenHarnessClient, "jobs">,
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
      const response = await client.jobs.read(jobId, {
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
    return await client.providers.listModels();
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
    const client = createDaemonClient(daemon);
    if (!client) return;
    clientRef.current = client;

    void (async () => {
      try {
        await client.protocol.health();
        const cwd = daemon.cwd ?? process.cwd();
        const [settings, sessions, commands] = await Promise.all([
          client.system.getSettings().catch(() => ({}) as Record<string, unknown>),
          client.sessions.list({ cwd, limit: 20 }),
          client.system.listCommands({ cwd }).catch(() => [] as CommandCatalogEntry[]),
        ]);
        const model = daemon.model ?? stringSetting(settings.model) ?? "default";
        setShowReasoning(settings.showReasoning !== false);
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
          void client.sessions.get(session.id).catch(() => {});
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
    const generation = ++syncGenerationRef.current;
    let reconnectNotice = false;

    const controller = new SessionSyncController({
      client,
      sessionId: activeSessionId,
      generation,
      onUpdate: (update, gen) => {
        if (gen !== syncGenerationRef.current) return;
        if (update.source === "reconnecting") {
          if (!reconnectNotice) {
            reconnectNotice = true;
            pushSystem("reconnecting...");
          }
          return;
        }
        if (reconnectNotice) reconnectNotice = false;
        commitClientState(update.state, shouldCoalesceClientState(update));
      },
      onError: (error, gen) => {
        if (gen !== syncGenerationRef.current) return;
        reportError(error instanceof Error ? error.message : String(error));
      },
    });

    void controller.start();

    return () => {
      clearPendingClientState();
      controller.abort();
    };
  }, [
    activeSessionId,
    clearPendingClientState,
    commitClientState,
    daemon?.token,
    daemon?.url,
    pushSystem,
    reportError,
  ]);

  useEffect(() => {
    const client = clientRef.current;
    const sessionId = activeSessionId;
    if (!client || !sessionId) return;
    const generation = ++auxiliaryGenerationRef.current;
    mcpAbortRef.current?.abort();
    const controller = new AbortController();
    mcpAbortRef.current = controller;
    const isCurrent = () => activeSessionIdRef.current === sessionId && auxiliaryGenerationRef.current === generation;

    void client.system.getSessionMcp(sessionId, { signal: controller.signal })
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
      const session = activeSessionId ? (clientState.sessions[activeSessionId] ?? (await client.sessions.get(activeSessionId))) : await createAndSwitchSession();
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
      executeTuiAction(action, {
        clientRef,
        activeSessionIdRef,
        clientState,
        setClientState,
        daemon,
        defaultRuntimeRef,
        nextSessionModeRef,
        statusRef,
        setStatus,
        setStatusAndDefault,
        listedSessionsRef,
        commandCatalogRef,
        pendingNewSessionTitleRef,
        localBusy,
        setLocalBusy,
        setSubmittedRun,
        setModal,
        setSelectRequest,
        clearDisplayRequest,
        showDisplayRequest,
        pushSystem,
        reportError,
        reportAuxiliaryError,
        activateSession,
        returnToHome,
        refreshJobs,
        loadJobDetail,
        createAndSwitchSession,
        cacheFirstRead,
        jobStateRef,
        setJobState,
        jobDetailStateRef,
        jobControlGenerationRef,
        jobDetailGenerationRef,
        jobControlAbortRef,
      }).catch((error) => {
        reportError(error instanceof Error ? error.message : String(error));
      });
    },
    [activateSession, cacheFirstRead, clearDisplayRequest, clientState, createAndSwitchSession, daemon, loadJobDetail, localBusy, pushSystem, refreshJobs, reportAuxiliaryError, reportError, returnToHome, setStatusAndDefault, showDisplayRequest],
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
    const base = splitStreamingAssistant(bucketToTranscript(bucket, { showReasoning }));
    return {
      transcript: [...base.items, ...recoveryItems, ...(activeSessionId ? (systemItemsBySession[activeSessionId] ?? []) : globalSystemItems)],
      assistantBuffer: base.assistantBuffer,
    };
  }, [activeSessionId, bucket, globalSystemItems, recoveryItems, showReasoning, systemItemsBySession]);
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
