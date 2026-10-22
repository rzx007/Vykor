import { pluginAppHostBinding } from "./plugin-app-host-binding.js";
import type { PluginAppRuntimeHost, HostedAgent } from "@vykor/agent-runtime";
import type { Settings } from "@vykor/host-config";
import { isCommittedModelPart } from "@vykor/domain-contracts/sessions";
import { readSessionRuntimeConfig } from "./runtime-configuration.js";
import type { PluginAppSource } from "@vykor/domain-contracts/plugin-apps";
import type { SessionStore } from "@vykor/services";
import { SessionPluginAppService } from "./session-plugin-app-service.js";
import {
  PluginAppOperationService,
  verifiedAppAction,
  type PluginAppOperationOptions,
} from "./plugin-app-operation-service.js";
import { PluginAppOperationExecutor } from "./plugin-app-operation-executor.js";
import type { DaemonOperationGate } from "../control/daemon-operation-gate.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { ApplicationError } from "../../shared/application-error.js";
import { verifiedStaticAppResources } from "./plugin-app-static-resources.js";
import { PluginAppNotifications } from "./plugin-app-notifications.js";
import type { PluginAppToolOrigin } from "@vykor/plugin-contracts/runtime";
import type { SessionMessagePartRecord, SessionRecord } from "@vykor/domain-contracts/sessions";
import {
  mcpToolResultToAppResult,
  nativeToolResultToAppResult,
} from "@vykor/agent-runtime";
import type { ToolResult } from "@vykor/agent-contracts";

type AppMutationScope = {
  kind: "global" | "cwd";
  cwd?: string;
  sessionId?: string;
  pluginId?: string;
};

/** Only host facades are retained here. All captures and the one lease table stay inside each Agent. */
export function assemblePluginApps(
  options: Omit<PluginAppOperationOptions, "apps" | "execute"> & {
    store: SessionStore;
    operationGate: DaemonOperationGate;
    events: SessionEventPublisher;
    settings(cwd: string): Promise<Settings | undefined>;
    waitForRuns(ids: string[]): Promise<void>;
  },
) {
  const hosts = new Map<string, PluginAppRuntimeHost>();
  const notifications = new PluginAppNotifications();
  const mutations = new Set<AppMutationScope>();
  const matches = (
    scope: AppMutationScope,
    sessionId: string,
    pluginId?: string,
  ) => {
    const session = options.store.sessions.get(sessionId);
    return (
      !!session &&
      (!scope.pluginId || !pluginId || scope.pluginId === pluginId) &&
      (!scope.sessionId || scope.sessionId === sessionId) &&
      (scope.kind !== "cwd" || scope.cwd === session.cwd)
    );
  };
  const blocked = (sessionId: string, pluginId?: string) =>
    [...mutations].some((scope) => matches(scope, sessionId, pluginId));
  const acquire = async (id: string): Promise<HostedAgent> => {
    const hosted = await options.acquireSession(id);
    if (!hosted.host) throw new Error("plugin_app_runtime_unavailable");
    hosts.set(id, hosted.host.plugins.pluginApps);
    return hosted;
  };
  const resolveToolResult = async (
    session: SessionRecord,
    part: SessionMessagePartRecord,
  ) => {
    if (!isCommittedModelPart(part)) return;
    const value = part.metadata.pluginAppSource;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const origin = value as PluginAppToolOrigin & {
      sessionId: string;
      runId: string;
      sourcePartId: string;
      toolUseId: string;
    };
    const message = options.store.conversations
      .listMessages(session.id)
      .find((item) => item.id === part.messageId);
    const run = message?.runId && options.store.runs.getRun(message.runId);
    if (
      !run ||
      run.sessionId !== session.id ||
      origin.sessionId !== session.id ||
      origin.runId !== run.id ||
      origin.sourcePartId !== part.id ||
      origin.toolUseId !== part.toolUseId ||
      origin.toolName !== part.toolName ||
      part.status !== "completed" ||
      part.isError ||
      !part.output ||
      typeof part.output !== "object" ||
      !("executionState" in part.output) ||
      part.output.executionState !== "completed"
    )
      return;
    const descriptor = await (
      await acquire(session.id)
    ).host!.plugins.pluginApps.resolveOrigin(origin);
    return descriptor
      ? { descriptor, resourceUri: origin.resourceUri }
      : undefined;
  };
  const apps = new SessionPluginAppService({
    store: options.store,
    resolveToolResult,
    catalogue: {
      list: async (session) => {
        const settings = await options.settings(session.cwd);
        if (
          blocked(session.id) ||
          settings?.plugins?.enabled === false ||
          settings?.plugins?.uiEnabled === false ||
          readSessionRuntimeConfig(session).pluginsEnabled === false
        )
          return [];
        return (await acquire(session.id)).host!.plugins.pluginApps.list();
      },
    },
    leaseAuthority: {
      issue: (app, generation) => {
        const host = hosts.get(app.sessionId);
        if (!host || blocked(app.sessionId, app.pluginId))
          throw new Error("plugin_app_runtime_unavailable");
        return host.issue(pluginAppHostBinding(app), generation);
      },
      validate: (app, lease, generation) =>
        !blocked(app.sessionId, app.pluginId) &&
        hosts.get(app.sessionId)?.validate(pluginAppHostBinding(app), lease, generation) === true,
      revoke: (source) => hosts.get(source.sessionId)?.revoke({ sessionId: source.sessionId, instanceId: source.appId }),
      clear: () => {
        for (const host of hosts.values()) host.clear();
        hosts.clear();
      },
    },
    resolveCurrent: async (session, app) => {
      const settings = await options.settings(session.cwd);
      if (
        !blocked(session.id, app.pluginId) &&
        settings?.plugins?.enabled !== false &&
        settings?.plugins?.uiEnabled !== false &&
        readSessionRuntimeConfig(session).pluginsEnabled !== false
      ) {
        try {
          const facts = await (
            await acquire(session.id)
          ).host!.plugins.pluginApps.refresh(pluginAppHostBinding(app));
          if (facts.resourceAvailable) return facts;
        } catch {
          /* exact static resources may still be readable */
        }
        const staticResources = await verifiedStaticAppResources(session, app);
        if (staticResources && !blocked(session.id, app.pluginId))
          return {
            enabled: true,
            renderApproved: true,
            invokeApproved: false,
            snapshot: "valid",
            resourceAvailable: true,
            toolsAvailable: false,
            isCurrent: () => false,
          };
      }
      hosts.get(session.id)?.revoke({ sessionId: session.id, instanceId: app.id });
      return {
        enabled: false,
        renderApproved: false,
        invokeApproved: false,
        snapshot: "missing",
        resourceAvailable: false,
        toolsAvailable: false,
        isCurrent: () => false,
      };
    },
    readExecutionState: (run, app) => {
      const action = verifiedAppAction(run, app);
      if (!action || action.executionState !== "completed")
        return action?.executionState;
      const part = options.store.conversations
        .listMessageParts(run.sessionId)
        .find((p) => p.id === action.toolUseId);
      const message =
        part &&
        options.store.conversations
          .listMessages(run.sessionId)
          .find((m) => m.id === part.messageId);
      return message?.runId === run.id &&
        part?.output &&
        typeof part.output === "object" &&
        (part.output as { executionState?: string }).executionState ===
          "completed"
        ? "completed"
        : undefined;
    },
    listTools: (app, lease) =>
      hosts.get(app.sessionId)?.listTools(pluginAppHostBinding(app), lease) ?? [],
  });
  let executor: PluginAppOperationExecutor;
  const actions = new PluginAppOperationService({
    ...options,
    apps,
    acquireSession: acquire,
    assertAvailable: (source) => {
      if (
        blocked(
          source.sessionId,
          options.store.pluginApps.get(source.appId)?.pluginId,
        )
      )
        throw new ApplicationError(409, "插件正在更新");
    },
    execute: (id, request, context) => executor.execute(id, request, context),
  });
  executor = new PluginAppOperationExecutor({
    store: options.store,
    service: actions,
    operationGate: options.operationGate,
    events: options.events,
  });
  const resources = async (
    source: PluginAppSource,
    lease?: { token: string; backendGeneration: string },
  ) => {
    const { app, facts } = await apps.assertCanReadResource(source);
    const port =
      facts.backendGeneration && lease
        ? (await acquire(source.sessionId)).host!.plugins.pluginApps.resource(
            pluginAppHostBinding(app),
            lease,
          )
        : await verifiedStaticAppResources(
            options.store.sessions.get(source.sessionId)!,
            app,
          );
    if (!port) throw new ApplicationError(409, "应用资源不可用");
    const after = async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      const latest = await apps.assertCanReadResource(source);
      if (
        facts.backendGeneration &&
        (!lease ||
          !hosts
            .get(source.sessionId)
            ?.validate(pluginAppHostBinding(latest.app), lease, facts.backendGeneration))
      )
        throw new ApplicationError(409, "应用运行凭证已失效");
      return result;
    };
    return {
      subscribeResource: async (
        uri: string,
        listener: () => void,
        signal: AbortSignal,
      ) => {
        if (
          !("supportsSubscriptions" in port) ||
          !port.supportsSubscriptions ||
          !port.subscribeResource ||
          !lease ||
          !facts.backendGeneration
        )
          return () => {};
        const generation = facts.backendGeneration;
        const current = () => {
          const latest = options.store.pluginApps.get(app.id);
          return (
            !!latest &&
            !blocked(source.sessionId, app.pluginId) &&
            hosts.get(source.sessionId)?.validate(pluginAppHostBinding(latest), lease, generation) ===
              true
          );
        };
        // Only a resource successfully read through this exact authorized port can be watched.
        await after(port.readResource(uri, signal));
        const stop = await port.subscribeResource(
          uri,
          () => {
            if (current()) listener();
          },
          signal,
        );
        if (signal.aborted || !current()) {
          stop();
          throw new ApplicationError(409, "应用运行凭证已失效");
        }
        return stop;
      },
      readResource: (uri: string, signal?: AbortSignal) =>
        after(port.readResource(uri, signal)),
      listResources: (cursor?: string, signal?: AbortSignal) =>
        after(port.listResources(cursor, signal)),
      listResourceTemplates: (cursor?: string, signal?: AbortSignal) =>
        after(port.listResourceTemplates(cursor, signal)),
    };
  };
  const revokeScope = async (scope: AppMutationScope): Promise<() => void> => {
    const owned = { ...scope };
    mutations.add(owned);
    try {
      const selected = options.store.pluginApps
        .list()
        .filter((app) => matches(scope, app.sessionId, app.pluginId));
      const checkpoint = options.events.checkpoint();
      const runIds: string[] = [];
      options.store.transaction(() => {
        for (const app of selected) {
          apps.invalidateLease({ sessionId: app.sessionId, appId: app.id });
          if (app.activeActionRunId) {
            runIds.push(app.activeActionRunId);
            options.interrupt(app.sessionId, app.activeActionRunId);
          }
        }
      });
      options.events.publishSince(checkpoint);
      await options.waitForRuns(runIds);
      const before = options.events.checkpoint();
      for (const id of runIds)
        actions.settle(
          id,
          "interrupted",
          undefined,
          "plugin_app_lifecycle_changed",
        );
      options.events.publishSince(before);
      return () => {
        mutations.delete(owned);
      };
    } catch (error) {
      mutations.delete(owned);
      throw error;
    }
  };
  const initialResult = async (
    source: PluginAppSource,
    lease: { token: string; backendGeneration: string },
    sourcePartId: string,
  ) => {
    const { app, facts } = await apps.assertCanReadResource(source);
    if (
      !facts.backendGeneration ||
      !hosts
        .get(source.sessionId)
        ?.validate(pluginAppHostBinding(app), lease, facts.backendGeneration)
    )
      throw new ApplicationError(409, "应用凭证失效");
    const part = options.store.conversations
      .listMessageParts(source.sessionId)
      .find((item) => item.id === sourcePartId);
    const origin =
      part &&
      (await resolveToolResult(
        options.store.sessions.get(source.sessionId)!,
        part,
      ));
    if (
      !part ||
      !origin ||
      origin.descriptor.pluginId !== app.pluginId ||
      origin.descriptor.backendId !== app.backendId ||
      origin.resourceUri !== app.resourceUri ||
      (app.origin.kind === "tool-result" && app.origin.sourcePartId !== part.id)
    )
      throw new ApplicationError(409, "工具结果来源不符");
    const result =
      app.backendKind === "mcp-server"
        ? mcpToolResultToAppResult(part.output as ToolResult)
        : nativeToolResultToAppResult(part.output as ToolResult);
    if (
      !hosts
        .get(source.sessionId)
        ?.validate(pluginAppHostBinding(app), lease, facts.backendGeneration)
    )
      throw new ApplicationError(409, "应用凭证失效");
    return { arguments: part.input ?? {}, ...result };
  };
  return {
    apps,
    actions,
    resources,
    notifications,
    initialResult,
    revokeScope,
    mutate: <T>(sessionId: string, work: () => Promise<T>) =>
      options.operations.run(sessionId, work),
  };
}
