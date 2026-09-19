import {
  createDefaultNodeAgent,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
  type ObservableJobProducer,
} from "@openharness/agent-runtime";
import { join } from "node:path";
import {
  getCoordinatorSystemPrompt,
  getCoordinatorTools,
  getCoordinatorUserContext,
} from "@openharness/coordinator";
import type { WorkflowRunRepository } from "@openharness/coordinator";
import { PROJECT_CONFIG_DIR_NAME } from "@openharness/core";
import type {
  AgentScheduleEffects,
  AgentBackgroundShellHost,
  AgentEffects,
  AgentEventListener,
  Settings,
  ToolDefinition,
} from "@openharness/core";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";
import { readSessionRuntimeConfig } from "@openharness/protocol";
import type {
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/protocol";

import { buildAgentTranscript } from "../application/agent/agent-transcript.js";

export interface CreateDaemonAgentContext {
  session: SessionRecord;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  options: OpenHarnessAgentOptions;
}

/**
 * 造 Agent 的最低层缝：测试和嵌入式宿主可以自己 new，不走 createDefaultNodeAgent。
 * 真正生产路径由 loader 调 createDefaultNodeAgent。
 */
export type CreateDaemonAgent = (
  context: CreateDaemonAgentContext,
) => Promise<OpenHarnessAgent>;

export interface LoadDaemonAgentContext {
  session: SessionRecord;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
}

/**
 * AgentPool.acquireSession 用的入口：给定 durable session + 历史，返回一个已接线的活 Agent。
 * 不 submitMessage；跑 prompt 是 SessionRunExecutor 的事。
 */
export type LoadDaemonAgent = (
  context: LoadDaemonAgentContext,
) => Promise<OpenHarnessAgent>;

export interface ResolveDaemonToolsContext {
  session: SessionRecord;
  settings?: Settings;
}

export type DaemonToolsProvider = (
  context: ResolveDaemonToolsContext,
) => Promise<ToolDefinition[]> | ToolDefinition[];

export interface DaemonAgentLoaderOptions {
  executionSurface?: "desktop_managed" | "cli_advanced";
  acquireEnvironment?(
    session: SessionRecord,
    settings: Settings,
  ): Promise<ExecutionEnvironmentHandle>;
  resolveReasoningEfforts?(input: {
    provider?: string;
    model?: string;
  }): Promise<string[] | undefined> | string[] | undefined;
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings> | Settings;
  createAgent?: CreateDaemonAgent;
  requestPermission?: AgentEffects["requestPermission"];
  schedules?: AgentScheduleEffects;
  createTerminal?(
    session: SessionRecord,
  ): ObservableJobProducer<AgentTerminalHost>;
  createBackgroundShell?(
    session: SessionRecord,
  ): ObservableJobProducer<AgentBackgroundShellHost>;
  workflowRepository?: WorkflowRunRepository;
  tools?: DaemonToolsProvider;
  toolOverrides?: ToolDefinition[];
  trustedToolOverrides?: string[];
  /**
   * 生产里就是给这个 Agent 建一个投影：把模型吐出的事件写成会话记录，再推给 UI。
   * 要等 Agent 造好才能建（投影要用 agent.id），但 onEvent 在造 Agent 时就得先挂上。
   */
  createEventSink?(
    agent: OpenHarnessAgent,
    session: SessionRecord,
  ): AgentEventListener;
}

/**
 * daemon 里「durable session → 内存 Agent」的唯一翻译点。
 *
 * AgentPool 每个 session 调一次 loader；返回的 Agent 已经：
 * - 带上该会话的 cwd / 模型 / 权限 / Job / Terminal
 * - loadHistory 灌过 store 里的 transcript
 * - onEvent 接到投影（字、工具、这次跑完都从这里进会话记录，再推到窗口）
 *
 * 没有 settings 也没有 createAgent 时返回 undefined，AgentPool.configured 就是 false。
 */
export function createDaemonAgentLoader(
  options: DaemonAgentLoaderOptions,
): LoadDaemonAgent | undefined {
  if (
    !options.createAgent &&
    !options.settings &&
    !options.getSettings &&
    !options.getSettingsForCwd
  )
    return undefined;

  return async ({ session, history, parts }) => {
    const settings = await resolveSettingsForSession(options, session.cwd);
    if (!options.createAgent && !settings)
      throw new Error("Agent settings are not configured");

    // 投影（createEventSink）要等 Agent 造好才有。造的过程中事件可能已经来了，不能丢。
    // pendingEvents：投影还没好时的纸箱
    // eventSink：准备好的投影
    // sinkBinding：正在把纸箱倒给投影；倒完之前，新事件先等着，别插队
    let eventSink: AgentEventListener | undefined;
    let sinkBinding: Promise<void> | undefined;
    const pendingEvents: Parameters<AgentEventListener>[0][] = [];

    // 没接线权限宿主时一律拒绝，避免工具在 daemon 里默认放行写操作。
    const requestPermission =
      options.requestPermission ??
      (async () => ({
        status: "denied" as const,
        reason: "Daemon permission host is not configured",
      }));
    const terminal = options.createTerminal?.(session);
    const backgroundShell = options.createBackgroundShell?.(session);
    const tools = (await options.tools?.({ session, settings })) ?? [];
    const executionEnvironment = settings && options.acquireEnvironment
      ? await options.acquireEnvironment(session, settings)
      : undefined;
    const configuration = agentConfigurationFromSession(session, settings);
    let declaredEfforts: string[] | undefined;
    try {
      declaredEfforts = await options.resolveReasoningEfforts?.({
        provider: configuration.provider,
        model: configuration.model,
      });
    } catch {
      declaredEfforts = undefined;
    }
    const chosenEffort = configuration.effort;
    const reasoningEffort =
      chosenEffort && declaredEfforts?.includes(chosenEffort)
        ? chosenEffort
        : undefined;
    const agentOptions: OpenHarnessAgentOptions = {
      ...(settings ? { settings } : {}),
      cwd: session.cwd,
      sessionId: session.id,
      ...(options.executionSurface ? { executionSurface: options.executionSurface } : {}),
      ...(executionEnvironment ? { executionEnvironment } : {}),
      ...configuration,
      reasoningEffort,
      capabilityOverrides: {
        ...(options.schedules ? { schedules: options.schedules } : {}),
        ...(terminal ? { terminal } : {}),
        ...(backgroundShell ? { backgroundShell } : {}),
        ...(options.workflowRepository
          ? { workflowRepository: options.workflowRepository }
          : {}),
      },
      effects: { requestPermission },
      ...(tools.length > 0 ? { tools } : {}),
      ...(options.toolOverrides ? { toolOverrides: options.toolOverrides } : {}),
      ...(options.trustedToolOverrides
        ? { trustedToolOverrides: options.trustedToolOverrides }
        : {}),
      ...(options.createEventSink
        ? {
            // 窗口上的字从这里来：事件 → 投影 → 会话记录 → 推给 UI。
            // 失败会打断这次跑；不是旁路看看就算了。
            onEvent: async (event) => {
              if (!eventSink) {
                pendingEvents.push(event);
                return;
              }
              await sinkBinding;
              await eventSink(event);
            },
          }
        : {}),
    };
    let agent: OpenHarnessAgent;
    try {
      agent = options.createAgent
        ? await options.createAgent({
            session,
            history,
            parts,
            options: agentOptions,
          })
        : await createDefaultNodeAgent(agentOptions);
    } catch (error) {
      await executionEnvironment?.release();
      throw error;
    }
    try {
      // 重启 daemon / 热加载 session 时，内存 Agent 是空的；必须先灌历史再对外暴露，
      // 否则下一句 prompt 会丢上下文。
      const transcript = buildAgentTranscript(history, parts);
      agent.loadHistory(transcript.messages);
      // Agent 有了，投影才能建。先把纸箱里攒的事件按顺序喂给它。
      eventSink = options.createEventSink?.(agent, session);
      if (eventSink && pendingEvents.length > 0) {
        const sink = eventSink;
        sinkBinding = (async () => {
          for (const event of pendingEvents) await sink(event);
          pendingEvents.length = 0;
        })();
        await sinkBinding;
        sinkBinding = undefined;
      }
      return agent;
    } catch (error) {
      try {
        await agent.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Daemon Agent initialization and cleanup failed: ${session.id}`,
        );
      }
      throw error;
    }
  };
}

/** 项目级设置优先于进程级，再退回构造时传入的静态 settings。 */
async function resolveSettingsForSession(
  options: DaemonAgentLoaderOptions,
  cwd: string,
): Promise<Settings | undefined> {
  return (
    (await options.getSettingsForCwd?.(cwd)) ??
    options.getSettings?.() ??
    options.settings
  );
}

/**
 * 把 session.metadata.runtime 和全局 settings 合成 Agent 配置。
 * 会话上存过的 model / permissionMode 覆盖默认值，这样换模型不用重建整个 daemon。
 */
function agentConfigurationFromSession(
  session: SessionRecord,
  settings: Settings | undefined,
): Partial<OpenHarnessAgentOptions> {
  const runtime = readSessionRuntimeConfig(session, {
    provider: settings?.provider,
    baseUrl: settings?.baseUrl,
    apiFormat: settings?.apiFormat,
    permissionMode: settings?.permission?.mode,
    maxTurns: settings?.maxTurns,
    sessionMode: "direct",
    pluginsEnabled: settings?.plugins?.enabled ?? true,
  });
  const configuration: Partial<OpenHarnessAgentOptions> = {
    model: runtime.model,
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    apiFormat: runtime.apiFormat,
    permissionMode: runtime.permissionMode,
    systemPrompt: runtime.systemPrompt,
    maxTurns: runtime.maxTurns,
    hostToolCeiling: runtime.allowedTools,
    disallowedTools: runtime.disallowedTools,
    effort: runtime.effort,
    // The persistent master switch is a ceiling: session metadata may disable
    // plugins, but an old session cannot re-enable them globally.
    pluginsEnabled: (settings?.plugins?.enabled ?? true) && (runtime.pluginsEnabled ?? true),
  };
  if (runtime.sessionMode === "coordinator") {
    // coordinator 模式换一套编排 prompt + 工具白名单（Agent/Job*/Workflow），
    // 会话自己的 systemPrompt 降级成「额外说明」附录，避免盖掉协调者角色。
    configuration.systemPrompt = coordinatorSystemPrompt({
      settings,
      cwd: session.cwd,
      sessionPrompt: configuration.systemPrompt,
      hostToolCeiling:
        configuration.hostToolCeiling ?? settings?.permission.allowedTools,
    });
    configuration.roleAllowedTools = getCoordinatorTools();
  }
  return configuration;
}

function coordinatorSystemPrompt(options: {
  settings: Settings | undefined;
  cwd: string;
  sessionPrompt: string | undefined;
  hostToolCeiling: string[] | undefined;
}): string {
  const sections = [getCoordinatorSystemPrompt()];
  const mcpClients = Object.keys(options.settings?.mcpServers ?? {})
    .sort()
    .map((name) => ({ name }));
  const context = getCoordinatorUserContext(
    mcpClients,
    join(options.cwd, PROJECT_CONFIG_DIR_NAME, "scratchpad"),
    {
      enabled: true,
      hostToolCeiling: options.hostToolCeiling,
    },
  );
  if (context.workerToolsContext?.trim()) {
    sections.push(`## Runtime Context\n\n${context.workerToolsContext.trim()}`);
  }
  if (options.sessionPrompt?.trim()) {
    sections.push(
      `## Additional Session Instructions\n\n${options.sessionPrompt.trim()}`,
    );
  }
  return sections.join("\n\n");
}
