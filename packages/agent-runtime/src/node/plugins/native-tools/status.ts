import { randomUUID } from "node:crypto";
import type { NativeToolHostState } from "./tool-host.js";

interface NativeToolRuntimeInstance {
  id: string;
  pluginId: string;
  pluginRoot: string;
  state: NativeToolHostState;
  toolNames: string[];
  startedAt: string;
  lastError?: string;
}

export interface NativeToolRuntimeSnapshot {
  state: NativeToolHostState;
  hostCount: number;
  registeredToolCount: number;
  toolNames: string[];
  lastStartedAt?: string;
  lastError?: string;
}

const instances = new Map<string, NativeToolRuntimeInstance>();

export function beginNativeToolRuntimeStatus(pluginId: string, pluginRoot: string) {
  const instance: NativeToolRuntimeInstance = {
    id: randomUUID(),
    pluginId,
    pluginRoot,
    state: "starting",
    toolNames: [],
    startedAt: new Date().toISOString(),
  };
  instances.set(instance.id, instance);
  return {
    update(patch: Partial<Pick<NativeToolRuntimeInstance, "state" | "toolNames" | "lastError">>): void {
      const current = instances.get(instance.id);
      if (current) Object.assign(current, patch);
    },
    remove(): void { instances.delete(instance.id); },
  };
}

/** Process-local aggregate. A plugin can have one host for each live Agent runtime. */
export function getNativeToolRuntimeSnapshot(pluginRoot: string): NativeToolRuntimeSnapshot {
  const matching = [...instances.values()].filter((item) => item.pluginRoot === pluginRoot);
  if (matching.length === 0) {
    return { state: "inactive", hostCount: 0, registeredToolCount: 0, toolNames: [] };
  }
  const state: NativeToolHostState = matching.some((item) => item.state === "active")
    ? "active"
    : matching.some((item) => item.state === "starting")
      ? "starting"
      : matching.some((item) => item.state === "degraded")
        ? "degraded"
        : matching.some((item) => item.state === "error") ? "error" : "inactive";
  const toolNames = [...new Set(matching.flatMap((item) => item.toolNames))].sort();
  const latest = [...matching].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const error = [...matching].reverse().find((item) => item.lastError)?.lastError;
  return {
    state,
    hostCount: matching.length,
    registeredToolCount: toolNames.length,
    toolNames,
    ...(latest ? { lastStartedAt: latest.startedAt } : {}),
    ...(error ? { lastError: error } : {}),
  };
}
