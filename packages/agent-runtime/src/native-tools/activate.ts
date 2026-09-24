import { RESERVED_SHELL_TOOL_NAMES, type IToolRegistry } from "@vykor/core";
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
    for (const definition of definitions) {
      if (RESERVED_SHELL_TOOL_NAMES.has(definition.name)) {
        throw new NativeToolHostError("tool_name_conflict", `Native Tool name is reserved: ${definition.name}`);
      }
      if (context.toolRegistry.has(definition.name)) {
        throw new NativeToolHostError("tool_name_conflict", `Native Tool name is already registered: ${definition.name}`);
      }
      context.toolRegistry.register({
        ...definition,
        execute: (input, toolContext) => {
          const view = toolContext.capabilityView;
          if (view && (view.pluginId !== plugin.manifest.id ||
            view.tools.get(definition.name)?.ownerPluginId !== plugin.manifest.id)) {
            return Promise.resolve({ isError: true, content: [{ type: "text" as const, text: "Native Tool is not available in this Run." }] });
          }
          return guard.run(
            definition.name,
            definition.inputSchema,
            input,
            toolContext,
            () => host.call(definition.name, input, {
              cwd: toolContext.cwd || context.cwd,
              ...(toolContext.sessionId ? { sessionId: toolContext.sessionId } : {}),
            }, toolContext.abortSignal),
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
