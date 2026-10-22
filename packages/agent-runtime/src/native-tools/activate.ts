import { RESERVED_SHELL_TOOL_NAMES } from "@vykor/agent-contracts";
import { type IToolRegistry } from "@vykor/core";
import type { LoadedNativePlugin, PluginDiagnostic } from "@vykor/plugins";
import { formatNativeToolAuditEvent, NativeToolCallGuard, type NativeToolAuditEvent } from "./guard.js";
import { NativeToolHost, NativeToolHostError, type NativeToolHostState } from "./tool-host.js";
import { beginNativeToolRuntimeStatus } from "./status.js";

export interface NativeToolActivationResult {
  pluginId: string;
  state: NativeToolHostState;
  toolNames: string[];
  diagnostics: PluginDiagnostic[];
  host?: NativeToolHost;
}

export async function activateNativePluginTools(
  plugin: LoadedNativePlugin,
  context: {
    cwd: string;
    dataRoot?: string;
    environmentKind?: "local" | "wsl";
    toolRegistry: IToolRegistry;
    addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void;
    onLog?: (message: string) => void;
    onAudit?: (event: NativeToolAuditEvent) => void;
    callTimeoutMs?: number;
    cancellationGraceMs?: number;
    maxConcurrentCalls?: number;
    outputMaxBytes?: number;
    logMessageMaxChars?: number;
  },
): Promise<NativeToolActivationResult> {
  if (!plugin.components.tools?.value?.length) {
    return { pluginId: plugin.manifest.id, state: "inactive", toolNames: [], diagnostics: [] };
  }
  if (context.environmentKind && context.environmentKind !== "local") {
    return {
      pluginId: plugin.manifest.id,
      state: "inactive",
      toolNames: [],
      diagnostics: [{
        severity: "warning",
        phase: "activate",
        code: "native_tools_unavailable_in_environment",
        message: "Native Plugin Tools are unavailable outside the local execution environment.",
        pluginId: plugin.manifest.id,
        component: "tools",
      }],
    };
  }
  const toolNames: string[] = [];
  const result: NativeToolActivationResult = { pluginId: plugin.manifest.id, state: "starting", toolNames: [], diagnostics: [] };
  const runtimeStatus = beginNativeToolRuntimeStatus(plugin.manifest.id, plugin.root);
  const guard = new NativeToolCallGuard({
    pluginId: plugin.manifest.id,
    maxConcurrentCalls: context.maxConcurrentCalls,
    onAudit: (event) => {
      context.onAudit?.(event);
      context.onLog?.(`[native-tool:audit] ${formatNativeToolAuditEvent(event)}`);
    },
  });
  const unregisterAll = () => {
    for (const name of toolNames.splice(0)) context.toolRegistry.unregister?.(name);
  };
  const host = new NativeToolHost(plugin, {
    dataRoot: context.dataRoot,
    callTimeoutMs: context.callTimeoutMs,
    cancellationGraceMs: context.cancellationGraceMs,
    outputMaxBytes: context.outputMaxBytes,
    logMessageMaxChars: context.logMessageMaxChars,
    onLog: (event) => context.onLog?.(`[native-tool:${event.level}] ${event.message}`),
    onCrash: (error) => {
      unregisterAll();
      result.state = "error";
      result.toolNames = [];
      result.diagnostics = [{ severity: "error", phase: "activate", code: error.code, message: error.message,
        pluginId: plugin.manifest.id, component: "tools" }];
      runtimeStatus.update({ state: "error", toolNames: [], lastError: error.message });
      context.onLog?.(`[native-tool:error] ${plugin.manifest.id}: ${error.message}`);
    },
  });
  context.addCleanup(async () => {
    unregisterAll();
    await host.stop();
    runtimeStatus.remove();
  }, () => {
    unregisterAll();
    host.stopSync();
    runtimeStatus.remove();
  });
  try {
    const definitions = await host.start();
    if (plugin.components.apps && plugin.components.apps.status !== "loaded") {
      throw new NativeToolHostError("plugin_app_invalid_definition", "Plugin app declarations are invalid.");
    }
    const appTools = new Map((plugin.components.apps?.value ?? []).flatMap(app =>
      app.definition.backends.flatMap(backend => backend.kind === "native-tools" ? backend.tools.map(tool => [tool.tool, tool] as const) : [])));
    // Check all mappings before registering anything. Never resolve a name from another plugin or builtin.
    for (const name of appTools.keys()) {
      if (!definitions.some(definition => definition.name === name)) {
        throw new NativeToolHostError("plugin_app_invalid_definition", `App tool must be registered by this plugin: ${name}`);
      }
    }
    for (const definition of definitions) {
      if (RESERVED_SHELL_TOOL_NAMES.has(definition.name)) {
        throw new NativeToolHostError("tool_name_conflict", `Native Tool name is reserved: ${definition.name}`);
      }
      if (context.toolRegistry.has(definition.name)) {
        throw new NativeToolHostError("tool_name_conflict", `Native Tool name is already registered: ${definition.name}`);
      }
      context.toolRegistry.register({
        ...definition,
        // Unmapped Native tools remain model tools; apps obtain only explicitly mapped registrations.
        ...(appTools.get(definition.name) ? { ui: {
          ...appTools.get(definition.name)!.ui, visibility: [...appTools.get(definition.name)!.visibility],
        } } : { ui: { visibility: ["model" as const] } }),
        execute: (input, toolContext) => {
          const view = toolContext.capabilityView;
          const captured = view?.tools.get(definition.name);
          if (view && (!(view.pluginIds ? view.pluginIds.has(plugin.manifest.id) : view.pluginId === plugin.manifest.id) ||
            captured?.ownerPluginId !== plugin.manifest.id || captured.source?.kind !== "plugin" || captured.source.id !== plugin.manifest.id)) {
            return Promise.resolve({ isError: true, content: [{ type: "text" as const, text: "Native Tool is not available in this Run." }] });
          }
          if (definition.execution?.network && (toolContext.environment?.info.networkMode === "none" ||
            (toolContext.settings?.sandbox?.enabled && toolContext.settings.sandbox.network?.mode === "none"))) {
            return Promise.resolve({
              isError: true, failureKind: "policy" as const, executionState: "not_started" as const,
              content: [{ type: "text" as const, text: "Tool requires network access, which is disabled in this Run." }],
            });
          }
          return guard.run(
            definition.name,
            definition.inputSchema,
            input,
            toolContext,
            async () => {
              const reference = definition.toolResultInput ? input[definition.toolResultInput] : undefined;
              const referenced = typeof reference === "string" ? toolContext.readToolResult?.(reference) : undefined;
              if (reference !== undefined && !referenced) return {
                isError: true, failureKind: "precondition" as const, executionState: "not_started" as const,
                content: [{ type: "text" as const, text: "Referenced tool result is unavailable in this Run. Fetch it again or use already saved plugin data." }],
              };
              return host.call(definition.name, input, {
                cwd: toolContext.cwd || context.cwd,
                ...(toolContext.sessionId ? { sessionId: toolContext.sessionId } : {}),
                ...(toolContext.agent?.scope.runId ? { runId: toolContext.agent.scope.runId } : {}),
                ...(referenced ? { toolResult: { toolUseId: referenced.toolUseId, toolName: referenced.toolName,
                  content: referenced.content, isError: referenced.isError } } : {}),
              }, toolContext.abortSignal);
            },
          );
        },
      }, { kind: "plugin", id: plugin.manifest.id });
      toolNames.push(definition.name);
    }
    runtimeStatus.update({ state: "active", toolNames: [...toolNames] });
    return Object.assign(result, { state: host.state, toolNames: [...toolNames], host });
  } catch (error) {
    unregisterAll();
    await host.stop().catch(() => undefined);
    const hostError = error instanceof NativeToolHostError ? error : new NativeToolHostError("tool_register_failed", String(error), { cause: error });
    runtimeStatus.update({ state: "error", toolNames: [], lastError: hostError.message });
    return {
      pluginId: plugin.manifest.id,
      state: "error",
      toolNames: [],
      diagnostics: [{
        severity: "error",
        phase: "activate",
        code: hostError.code,
        message: hostError.message,
        pluginId: plugin.manifest.id,
        component: "tools",
      }],
    };
  }
}
