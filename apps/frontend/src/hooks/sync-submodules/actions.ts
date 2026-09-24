import {
  createPromptRequestId,
  patchSessionRuntimeMetadata,
  type CommandCatalogEntry,
  type JobResource,
  type VykorClient,
  type VykorClientState,
  type SessionRecord,
} from "@vykor/client";

import type { FrontendConfig } from "../../types";
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
} from "../../jobs/job-remote-state";
import type { TuiAction, TuiSessionController } from "../sessionController";
import {
  dispatchSessionSlashCommand,
  parseSlashLine,
} from "../sessionSlashCommands";
import {
  archiveClientSession,
  listTopLevelSessions,
  recoverableInterruptedRuns,
  sessionRuntimeMetadata,
  sessionSelectOptions,
} from "./view-model";
import { normalizeSessionMode, statusSessionMode } from "./connection";

export const JOBS_AUXILIARY_SLASH_COMMANDS = new Set([
  "/agents",
  "/background",
  "/doctor",
  "/jobs",
  "/stats",
]);

type ActionClient = Pick<
  VykorClient,
  | "protocol" | "system" | "providers" | "auth" | "projects"
  | "plugins" | "development" | "sessions" | "jobs" | "permissions"
>;

export interface ActionDispatcherContext {
  clientRef: { current: ActionClient | null };
  activeSessionIdRef: { current: string | undefined };
  clientState: VykorClientState;
  setClientState: React.Dispatch<React.SetStateAction<VykorClientState>>;
  daemon: FrontendConfig["daemon"];
  defaultRuntimeRef: { current: { model: string; provider?: string; baseUrl?: string; apiFormat?: "anthropic" | "openai" } };
  nextSessionModeRef: { current: "coordinator" | "direct" };
  statusRef: { current: Record<string, unknown> };
  setStatus: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  setStatusAndDefault: (value: React.SetStateAction<Record<string, unknown>>) => void;
  listedSessionsRef: { current: Record<string, SessionRecord> };
  commandCatalogRef: { current: CommandCatalogEntry[] };
  pendingNewSessionTitleRef: { current: string | undefined };
  localBusy: boolean;
  setLocalBusy: (busy: boolean) => void;
  setSubmittedRun: (run: { sessionId: string; runId: string } | null) => void;
  setModal: (modal: Record<string, unknown> | null) => void;
  setSelectRequest: React.Dispatch<React.SetStateAction<TuiSessionController["selectRequest"]>>;
  clearDisplayRequest: () => void;
  showDisplayRequest: (request: NonNullable<TuiSessionController["displayRequest"]>) => void;
  pushSystem: (text: string) => void;
  reportError: (message: string) => void;
  reportAuxiliaryError: (scope: string, error: unknown) => void;
  activateSession: (session: SessionRecord) => void;
  returnToHome: (title?: string) => void;
  refreshJobs: () => Promise<void>;
  refreshSettings?: () => void | Promise<void>;
  loadJobDetail: (client: Pick<VykorClient, "jobs">, sessionId: string, jobId: string) => Promise<void>;
  createAndSwitchSession: (title?: string) => Promise<SessionRecord | undefined>;
  cacheFirstRead: (request: import("@vykor/client").PresentationReadRequest) => void;
  jobStateRef: { current: JobRemoteState };
  setJobState: React.Dispatch<React.SetStateAction<JobRemoteState>>;
  jobDetailStateRef: { current: JobDetailRemoteState };
  jobControlGenerationRef: { current: number };
  jobDetailGenerationRef: { current: number };
  jobControlAbortRef: { current: AbortController | null };
}

export async function executeTuiAction(
  action: TuiAction,
  ctx: ActionDispatcherContext,
): Promise<void> {
  const client = ctx.clientRef.current;
  let sessionId = ctx.activeSessionIdRef.current;
  const runtimeAction = action as TuiAction | { type?: unknown };
  const runtimeType = typeof runtimeAction.type === "string" ? runtimeAction.type : "unknown";

  switch (action.type) {
    case "select_model": {
      if (!client) return;
      const model = action.model.trim();
      const provider = action.provider?.trim() ?? "";
      if (!model) return;

      if (sessionId) {
        const session = await client.sessions.update(sessionId, {
          metadata: patchSessionRuntimeMetadata(
            {},
            {
              model,
              ...(provider ? { provider } : {}),
            },
          ),
        });
        ctx.activateSession(session);
      } else {
        const settingsPatch: Record<string, unknown> = { model };
        if (provider) settingsPatch.provider = provider;
        await client.system.patchSettings(settingsPatch);
        ctx.defaultRuntimeRef.current = {
          ...ctx.defaultRuntimeRef.current,
          model,
          ...(provider ? { provider } : {}),
        };
        ctx.setStatus((current) => ({
          ...current,
          model,
          ...(provider ? { provider } : {}),
        }));
      }
      ctx.pushSystem(`Model selected: ${model}`);
      return;
    }

    case "submit_line": {
      if (!client) return;
      const line = action.line;
      const slash = parseSlashLine(line);

      const newSession = line.match(/^\/new(?:\s+(.+))?$/);
      if (newSession) {
        ctx.returnToHome(newSession[1]);
        return;
      }
      const switchSession = line.match(/^\/sessions\s+open\s+(.+)$/);
      if (switchSession?.[1]) {
        const target = switchSession[1].trim();
        ctx.setLocalBusy(false);
        ctx.setSubmittedRun(null);
        ctx.pendingNewSessionTitleRef.current = undefined;
        ctx.setSelectRequest(null);
        const knownSession = ctx.clientState.sessions[target] ?? ctx.listedSessionsRef.current[target];
        if (knownSession) {
          ctx.activateSession(knownSession);
          return;
        }
        const session = await client.sessions.get(target);
        ctx.activateSession(session);
        return;
      }

      if (slash?.name === "/resume") {
        if (!sessionId) {
          ctx.pushSystem("No active session to resume.");
          return;
        }
        const recoverable = recoverableInterruptedRuns(ctx.clientState.buckets[sessionId]);
        if (!slash.args) {
          if (recoverable.length === 0) {
            ctx.pushSystem("No interrupted prompt runs are available to resume.");
            return;
          }
          ctx.clearDisplayRequest();
          ctx.setSelectRequest({
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
          ctx.pushSystem(`Run is not available for recovery: ${runId}`);
          return;
        }
        ctx.setLocalBusy(true);
        const response = await client.sessions.resumeInterruptedRun(sessionId, runId, { id: createPromptRequestId() });
        ctx.setLocalBusy(false);
        ctx.setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
        ctx.setSelectRequest(null);
        return;
      }

      let slashResult: Awaited<ReturnType<typeof dispatchSessionSlashCommand>>;
      try {
        slashResult = await dispatchSessionSlashCommand(slash, {
          client,
          sessionId,
          pushSystem: ctx.pushSystem,
          presentSystem: (title, content) => ctx.showDisplayRequest({ title, content }),
          statusRef: ctx.statusRef,
          commandCatalogRef: ctx.commandCatalogRef,
          clientState: ctx.clientState,
          localBusy: ctx.localBusy,
          cacheFirstRead: ctx.cacheFirstRead,
          daemon: ctx.daemon,
          setStatus: ctx.setStatusAndDefault,
          onSettingsChanged: ctx.refreshSettings,
        });
      } catch (error) {
        if (slash && JOBS_AUXILIARY_SLASH_COMMANDS.has(slash.name)) {
          ctx.reportAuxiliaryError("Jobs", error);
          return;
        }
        throw error;
      }
      if (slashResult === "handled") {
        if (slash?.name === "/background" && slash.args.trim() && sessionId) {
          await ctx.refreshJobs();
        }
        return;
      }
      if (slashResult === "local_ui_ignored") return;

      if (slash) {
        const catalogEntry = ctx.commandCatalogRef.current.find((entry) => entry.name === slash.name);
        if (catalogEntry?.kind === "template") {
          if (!sessionId) return;
          ctx.setLocalBusy(true);
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
          ctx.setLocalBusy(false);
          ctx.setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
          return;
        }
        ctx.pushSystem(`Unknown command: ${slash.name}`);
        return;
      }

      if (!sessionId) {
        const session = await ctx.createAndSwitchSession(ctx.pendingNewSessionTitleRef.current);
        if (!session) return;
        sessionId = session.id;
      }
      ctx.setLocalBusy(true);
      const response = await client.sessions.admitPrompt(sessionId, {
        id: createPromptRequestId(),
        items: [{ type: "text", text: line }],
      });
      ctx.setLocalBusy(false);
      ctx.setSubmittedRun(response.run ? { sessionId, runId: response.run.id } : null);
      return;
    }

    case "delete_session": {
      if (!client) return;
      const target = action.session_id;
      if (!target) return;
      const archived = await client.sessions.archive(target);
      const archivedAt = archived.archivedAt ?? Date.now();
      delete ctx.listedSessionsRef.current[target];
      ctx.setClientState((current) => archiveClientSession(current, target, archivedAt));
      ctx.setLocalBusy(false);
      ctx.setSubmittedRun(null);
      ctx.setSelectRequest((current) =>
        current
          ? {
              ...current,
              options: current.options.filter((option) => option.value !== target),
            }
          : current,
      );
      if (target === ctx.activeSessionIdRef.current) {
        const remaining = listTopLevelSessions(
          Object.values({
            ...ctx.clientState.sessions,
            ...ctx.listedSessionsRef.current,
            [target]: { ...archived, status: "archived", archivedAt },
          }),
        );
        if (remaining[0]) {
          ctx.activateSession(remaining[0]);
        } else {
          const sessions = await client.sessions.list({
            cwd: ctx.daemon?.cwd ?? undefined,
            includeArchived: false,
            limit: 20,
          });
          ctx.listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
          const remoteNext = sessions.find((session) => session.id !== target);
          if (remoteNext) ctx.activateSession(remoteNext);
          else ctx.returnToHome();
        }
      }
      return;
    }

    case "interrupt": {
      if (!client) return;
      if (sessionId) await client.sessions.interrupt(sessionId);
      ctx.setLocalBusy(false);
      ctx.setSubmittedRun(null);
      return;
    }

    case "permission_response": {
      if (!client) return;
      const requestId = action.request_id;
      const allowed = action.allowed;
      await client.permissions.reply(requestId, {
        status: allowed ? "approved" : "denied",
        decision: action.scope === "session" ? "session" : "once",
        clientId: "tui",
      });
      ctx.setModal(null);
      return;
    }

    case "list_sessions": {
      if (!client) return;
      const cachedSessions = {
        ...ctx.listedSessionsRef.current,
        ...ctx.clientState.sessions,
      };
      const cachedOptions = sessionSelectOptions(Object.values(cachedSessions), ctx.activeSessionIdRef.current);
      ctx.clearDisplayRequest();
      ctx.setSelectRequest({
        title: "Sessions",
        submitPrefix: "/sessions open ",
        options: cachedOptions,
      });
      const sessions = await client.sessions.list({
        cwd: ctx.daemon?.cwd ?? undefined,
        includeArchived: false,
        limit: 20,
      });
      ctx.listedSessionsRef.current = Object.fromEntries(sessions.map((session) => [session.id, session]));
      ctx.setSelectRequest((current) =>
        current?.submitPrefix === "/sessions open "
          ? {
              title: "Sessions",
              submitPrefix: "/sessions open ",
              options: sessionSelectOptions(sessions, ctx.activeSessionIdRef.current),
            }
          : current,
      );
      return;
    }

    case "set_permission_mode": {
      if (!client) return;
      const mode = action.permission_mode;
      ctx.setStatus((current) => ({ ...current, permission_mode: mode }));
      if (sessionId) {
        await client.sessions.update(sessionId, {
          metadata: patchSessionRuntimeMetadata({}, { permissionMode: mode }),
        });
      }
      return;
    }

    case "question_response": {
      if (!client) return;
      ctx.reportError("Interactive question responses are not available through the daemon client.");
      return;
    }

    case "set_session_mode": {
      if (!client) return;
      if (sessionId) {
        ctx.pushSystem("Coordinator mode can only be changed before starting a new session. Use /new first.");
        return;
      }
      const mode = normalizeSessionMode(action.session_mode);
      ctx.nextSessionModeRef.current = statusSessionMode(mode);
      ctx.setStatus((current) => ({
        ...current,
        session_mode: ctx.nextSessionModeRef.current,
      }));
      return;
    }

    case "job_request": {
      if (!client) {
        ctx.reportAuxiliaryError("Jobs", "The daemon client is not connected.");
        return;
      }
      const currentSessionId = ctx.activeSessionIdRef.current;
      if (!currentSessionId) return;
      try {
        switch (action.job_action) {
          case "open":
            await ctx.refreshJobs();
            return;
          case "refresh": {
            ctx.jobControlGenerationRef.current += 1;
            ctx.jobControlAbortRef.current?.abort();
            ctx.jobControlAbortRef.current = null;
            const detail = ctx.jobDetailStateRef.current;
            const detailJobId = detail.status === "idle" ? undefined : detail.jobId;
            await Promise.all([
              ctx.refreshJobs(),
              detailJobId
                ? ctx.loadJobDetail(client, currentSessionId, detailJobId)
                : Promise.resolve(),
            ]);
            return;
          }
          case "select":
            ctx.jobControlGenerationRef.current += 1;
            ctx.jobControlAbortRef.current?.abort();
            ctx.jobControlAbortRef.current = null;
            await ctx.loadJobDetail(client, currentSessionId, action.job_id);
            return;
          case "cancel": {
            const controlGeneration = ++ctx.jobControlGenerationRef.current;
            const detailGeneration = ctx.jobDetailGenerationRef.current;
            ctx.jobControlAbortRef.current?.abort();
            const controller = new AbortController();
            ctx.jobControlAbortRef.current = controller;
            let response: Awaited<ReturnType<JobResource["cancel"]>>;
            try {
              response = await client.jobs.cancel(
                action.job_id,
                {
                  sessionId: currentSessionId,
                  reason: action.reason,
                },
                { signal: controller.signal },
              );
            } catch (error) {
              if (ctx.activeSessionIdRef.current !== currentSessionId) return;
              if (controller.signal.aborted || ctx.jobControlGenerationRef.current !== controlGeneration) {
                await ctx.refreshJobs();
                return;
              }
              throw error;
            } finally {
              if (ctx.jobControlAbortRef.current === controller) ctx.jobControlAbortRef.current = null;
            }
            if (ctx.activeSessionIdRef.current !== currentSessionId) return;
            const ownsDetail = !controller.signal.aborted &&
              ctx.jobControlGenerationRef.current === controlGeneration &&
              ctx.jobDetailGenerationRef.current === detailGeneration;
            const validated = validateJobSnapshot(response, currentSessionId, action.job_id);
            if (!validated.snapshot) {
              if (controller.signal.aborted || ctx.jobControlGenerationRef.current !== controlGeneration) {
                await ctx.refreshJobs();
                return;
              }
              throw new Error(validated.error ?? "Job snapshot has invalid fields.");
            }
            const snapshot = validated.snapshot;
            const next = mergeJobSnapshot(ctx.jobStateRef.current, snapshot, Date.now());
            ctx.jobStateRef.current = next;
            ctx.setJobState(next);
            if (ownsDetail) {
              await ctx.loadJobDetail(client, currentSessionId, action.job_id);
            }
            await ctx.refreshJobs();
            return;
          }
          case "send": {
            const controlGeneration = ++ctx.jobControlGenerationRef.current;
            const detailGeneration = ctx.jobDetailGenerationRef.current;
            ctx.jobControlAbortRef.current?.abort();
            const controller = new AbortController();
            ctx.jobControlAbortRef.current = controller;
            try {
              await client.jobs.send(
                action.job_id,
                {
                  sessionId: currentSessionId,
                  data: action.data,
                },
                { signal: controller.signal },
              );
            } catch (error) {
              if (ctx.activeSessionIdRef.current !== currentSessionId) return;
              if (controller.signal.aborted || ctx.jobControlGenerationRef.current !== controlGeneration) {
                await ctx.refreshJobs();
                return;
              }
              throw error;
            } finally {
              if (ctx.jobControlAbortRef.current === controller) ctx.jobControlAbortRef.current = null;
            }
            if (ctx.activeSessionIdRef.current !== currentSessionId) return;
            const ownsDetail = !controller.signal.aborted &&
              ctx.jobControlGenerationRef.current === controlGeneration &&
              ctx.jobDetailGenerationRef.current === detailGeneration;
            if (ownsDetail) {
              await ctx.loadJobDetail(client, currentSessionId, action.job_id);
            }
            await ctx.refreshJobs();
            return;
          }
        }
      } catch (error) {
        ctx.reportAuxiliaryError("Jobs", error);
        return;
      }
    }

    default: {
      const exhaustive: never = action;
      void exhaustive;
      ctx.reportError(`Unsupported TUI action: ${runtimeType}`);
      return;
    }
  }
}
