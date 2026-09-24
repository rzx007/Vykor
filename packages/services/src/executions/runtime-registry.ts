import { join, resolve } from "node:path";
import process from "node:process";

import { getProjectConfigDir } from "@vykor/core";

import { ChildAgentExecutionRegistry } from "./child-agent-execution-registry.js";
import { DetachedProcessSupervisor } from "./detached-process-supervisor.js";
import type { ExecutionRuntimeScope } from "./types.js";

let defaultProcessSupervisor: DetachedProcessSupervisor | undefined;
let defaultChildRegistry: ChildAgentExecutionRegistry | undefined;
const processSupervisors = new Map<string, DetachedProcessSupervisor>();
const childRegistries = new Map<string, ChildAgentExecutionRegistry>();

function normalizeCwd(cwd: string): string {
  const root = resolve(cwd);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed || undefined;
}

function runtimeKey(scope: ExecutionRuntimeScope): string {
  const cwd = normalizeCwd(scope.cwd);
  const sessionId = normalizeSessionId(scope.sessionId);
  return sessionId ? `${cwd}::session=${sessionId}` : cwd;
}

function scopedOutputDir(scope: ExecutionRuntimeScope, backend: "processes" | "child-agents"): string {
  const sessionId = normalizeSessionId(scope.sessionId);
  const root = join(getProjectConfigDir(scope.cwd), "executions", backend);
  if (!sessionId) return root;
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(root, "sessions", safeSessionId);
}

export function getDetachedProcessSupervisor(
  scope?: string | ExecutionRuntimeScope,
): DetachedProcessSupervisor {
  if (!scope) {
    defaultProcessSupervisor ??= new DetachedProcessSupervisor();
    return defaultProcessSupervisor;
  }
  const normalized = typeof scope === "string" ? { cwd: scope } : scope;
  const key = runtimeKey(normalized);
  let supervisor = processSupervisors.get(key);
  if (!supervisor) {
    supervisor = new DetachedProcessSupervisor(scopedOutputDir(normalized, "processes"));
    processSupervisors.set(key, supervisor);
  }
  return supervisor;
}

export function getChildAgentExecutionRegistry(
  scope?: string | ExecutionRuntimeScope,
): ChildAgentExecutionRegistry {
  if (!scope) {
    defaultChildRegistry ??= new ChildAgentExecutionRegistry();
    return defaultChildRegistry;
  }
  const normalized = typeof scope === "string" ? { cwd: scope } : scope;
  const key = runtimeKey(normalized);
  let registry = childRegistries.get(key);
  if (!registry) {
    registry = new ChildAgentExecutionRegistry(scopedOutputDir(normalized, "child-agents"));
    childRegistries.set(key, registry);
  }
  return registry;
}

export function resetExecutionRuntimes(scope?: string | ExecutionRuntimeScope): void {
  if (!scope) {
    defaultProcessSupervisor?.close();
    defaultChildRegistry?.close();
    defaultProcessSupervisor = undefined;
    defaultChildRegistry = undefined;
    for (const supervisor of processSupervisors.values()) supervisor.close();
    for (const registry of childRegistries.values()) registry.close();
    processSupervisors.clear();
    childRegistries.clear();
    return;
  }

  const normalized = typeof scope === "string" ? { cwd: scope } : scope;
  const exact = runtimeKey(normalized);
  const sessionId = normalizeSessionId(normalized.sessionId);
  const keys = sessionId
    ? [exact]
    : [...new Set([...processSupervisors.keys(), ...childRegistries.keys()])]
      .filter((candidate) => candidate === exact || candidate.startsWith(`${exact}::session=`));
  for (const key of keys) {
    processSupervisors.get(key)?.close();
    childRegistries.get(key)?.close();
    processSupervisors.delete(key);
    childRegistries.delete(key);
  }
}

/**
 * Remove every registered execution runtime and wait for owned process trees to exit.
 * Daemon shutdown uses this instead of the synchronous test reset so shutdown does
 * not report success while background commands are still running.
 */
export async function closeExecutionRuntimes(): Promise<void> {
  const supervisors = [
    ...(defaultProcessSupervisor ? [defaultProcessSupervisor] : []),
    ...processSupervisors.values(),
  ];
  const registries = [
    ...(defaultChildRegistry ? [defaultChildRegistry] : []),
    ...childRegistries.values(),
  ];

  defaultProcessSupervisor = undefined;
  defaultChildRegistry = undefined;
  processSupervisors.clear();
  childRegistries.clear();

  for (const registry of registries) registry.close();
  const settled = await Promise.allSettled(supervisors.map(async (supervisor) => {
    await supervisor.aclose();
  }));
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Failed to close execution runtimes");
  }
}
