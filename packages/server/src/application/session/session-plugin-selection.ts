import type { AgentExecutionLimits } from "@vykor/core";
import type { PluginSelectionCandidate, PluginSelectionResult, VykorAgent } from "@vykor/agent-runtime";
import { readRuntimeMetadata, type SessionInputRecord, type SessionRecord, type SessionRunRecord } from "@vykor/protocol";

export interface InputPluginScope {
  scopeVersion: 2;
  source: "auto" | "none";
  pluginIds: string[];
  candidates: PluginSelectionCandidate[];
}

export type RunPluginSelection = PluginSelectionResult & {
  status: "resolved";
  source: "explicit" | "inherited" | "auto" | "none";
  scopeVersion?: 2;
  pluginIds?: string[];
  candidates?: PluginSelectionCandidate[];
};

/** Capture eligibility with the Input, independently of later session selections. */
export function capturePluginSelectionPolicy(session: SessionRecord): "auto" | "none" {
  const runtime = readRuntimeMetadata(session.metadata);
  return runtime.pluginsEnabled !== false && runtime.pluginAutoSelectionEnabled !== false &&
    typeof session.metadata?.activePluginId !== "string" ? "auto" : "none";
}

export function emptyPluginScope(): InputPluginScope {
  return { scopeVersion: 2, source: "none", pluginIds: [], candidates: [] };
}

export function readInputPluginScope(value: unknown): InputPluginScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Saved plugin scope is invalid; please resubmit the prompt");
  const scope = value as InputPluginScope;
  if (scope.scopeVersion !== 2 || (scope.source !== "auto" && scope.source !== "none") ||
    !Array.isArray(scope.pluginIds) || !Array.isArray(scope.candidates) ||
    scope.pluginIds.some(id => typeof id !== "string") ||
    new Set(scope.pluginIds).size !== scope.pluginIds.length ||
    scope.candidates.length !== scope.pluginIds.length ||
    scope.candidates.some((candidate, index) => !candidate || candidate.pluginId !== scope.pluginIds[index] ||
      typeof candidate.displayName !== "string" || typeof candidate.description !== "string" ||
      typeof candidate.version !== "string" ||
      (candidate.behaviorDigest !== undefined && typeof candidate.behaviorDigest !== "string")) ||
    (scope.source === "none" && scope.pluginIds.length > 0)) {
    throw new Error("Saved plugin scope is invalid; please resubmit the prompt");
  }
  return scope;
}

/** Read the immutable, versioned authorization saved for an executing Run. */
export function readRunPluginScope(run: SessionRunRecord): InputPluginScope | undefined {
  const selection = run.metadata.pluginSelection as {
    status?: string; scopeVersion?: number; source?: string; pluginId?: string | null; pluginIds?: unknown;
  } | undefined;
  if (selection?.scopeVersion !== 2) return undefined;
  const manual = selection.source === "explicit" || selection.source === "inherited";
  if (selection.status !== "resolved" || (manual
    ? typeof selection.pluginId !== "string" || run.metadata.pluginId !== selection.pluginId ||
      !Array.isArray(selection.pluginIds) || selection.pluginIds.length !== 1 || selection.pluginIds[0] !== selection.pluginId
    : selection.pluginId !== null || run.metadata.pluginId !== null)) {
    throw new Error("Invalid saved plugin source scope");
  }
  return readInputPluginScope(manual ? { ...selection, source: "auto" } : selection);
}

/** Legacy single-plugin Runs remain readable; versioned Runs require exact provenance. */
export function runPluginSourceMatches(run: SessionRunRecord, source: {
  pluginId: string; pluginVersion: string; pluginDigest: string | undefined;
}): boolean {
  try {
    const scope = readRunPluginScope(run);
    if (scope) {
      const candidate = scope.candidates.find(item => item.pluginId === source.pluginId);
      return candidate?.version === source.pluginVersion && candidate.behaviorDigest === source.pluginDigest;
    }
    return run.metadata.pluginId === source.pluginId;
  } catch {
    return false;
  }
}

/** The executor validates host snapshots; this path never makes a model request. */
export async function resolveRunPluginSelection(options: {
  session: SessionRecord;
  run: SessionRunRecord;
  input: SessionInputRecord;
  agent: Pick<VykorAgent, "getPluginCandidates" | "validatePluginScope">;
  signal: AbortSignal;
  traceId: string;
  limits?: AgentExecutionLimits;
}): Promise<RunPluginSelection> {
  const { session, run, input, agent, signal } = options;
  signal.throwIfAborted();
  const runtime = readRuntimeMetadata(session.metadata);
  const none = (): RunPluginSelection => ({ ...emptyPluginScope(), status: "resolved", pluginId: null, reason: "no_match" });
  const previous = run.metadata?.pluginSelection as RunPluginSelection | undefined;
  if (previous?.status === "resolved") {
    if ((previous.scopeVersion !== undefined && previous.scopeVersion !== 2) ||
      !["auto", "none", "explicit", "inherited"].includes(previous.source)) {
      throw new Error("Saved plugin scope is invalid; please resubmit the prompt");
    }
    const ids = previous.scopeVersion === 2 ? previous.pluginIds ?? [] : previous.pluginId ? [previous.pluginId] : [];
    if (ids.length && runtime.pluginsEnabled === false) throw new Error(`Plugin is disabled: ${ids.join(", ")}`);
    if (previous.scopeVersion === 2) {
      const manual = previous.source === "explicit" || previous.source === "inherited";
      if ((manual && (typeof previous.pluginId !== "string" || previous.pluginIds?.length !== 1 || previous.pluginIds[0] !== previous.pluginId)) ||
        (!manual && previous.pluginId !== null)) throw new Error("Saved plugin scope is invalid; please resubmit the prompt");
      const scope = readInputPluginScope(previous.source === "auto" || previous.source === "none" ? previous : {
        ...previous, source: previous.pluginIds?.length ? "auto" : "none",
      });
      if (scope?.candidates.length) {
        if (!agent.validatePluginScope) throw new Error("Plugin scope validation unavailable");
        await agent.validatePluginScope(scope.candidates, signal);
      }
    } else if (previous.pluginId && (previous.source === "auto" || previous.version || previous.behaviorDigest)) {
      const candidate = agent.getPluginCandidates?.().find(item => item.pluginId === previous.pluginId);
      if (!candidate || !agent.validatePluginScope) throw new Error(`Plugin is unavailable: ${previous.pluginId}`);
      await agent.validatePluginScope([{ ...candidate,
        ...(previous.version ? { version: previous.version } : {}),
        ...(previous.behaviorDigest ? { behaviorDigest: previous.behaviorDigest } : {}),
      }], signal);
    }
    signal.throwIfAborted();
    return previous;
  }
  // Explicit/manual scopes remain restricted and never silently become baseline.
  if (typeof run.metadata?.pluginId === "string") {
    if (runtime.pluginsEnabled === false) throw new Error(`Plugin is disabled: ${run.metadata.pluginId}`);
    const candidate = agent.getPluginCandidates?.().find(item => item.pluginId === run.metadata.pluginId);
    if (typeof agent.getPluginCandidates === "function" && !candidate) throw new Error(`Plugin is unavailable: ${run.metadata.pluginId}`);
    if (candidate) {
      if (!agent.validatePluginScope) throw new Error("Plugin scope validation unavailable");
      await agent.validatePluginScope([candidate], signal);
      signal.throwIfAborted();
    }
    return { status: "resolved", pluginId: run.metadata.pluginId, reason: "matched",
      ...(candidate ? { scopeVersion: 2, pluginIds: [candidate.pluginId], candidates: [candidate] } : {}),
      source: input.items.some(item => item.type === "capability" || item.type === "skill") ? "explicit" : "inherited" };
  }
  if (runtime.pluginsEnabled === false) return none();
  const scope = readInputPluginScope(input.metadata.pluginScope);
  if (scope) {
    if (scope.source === "none") return none();
    if (scope.candidates.length && !agent.validatePluginScope) throw new Error("Plugin scope validation unavailable");
    const candidates: PluginSelectionCandidate[] = [];
    for (const candidate of scope.candidates) {
      try {
        await agent.validatePluginScope([candidate], signal);
        candidates.push(candidate);
      } catch {
        // A newly admitted automatic Run can proceed with the healthy plugins.
        // Resolved/recovered scopes above are checked strictly instead.
        signal.throwIfAborted();
      }
    }
    signal.throwIfAborted();
    return { status: "resolved", source: "auto", pluginId: null,
      reason: candidates.length ? "matched" : "no_candidates", scopeVersion: 2,
      pluginIds: candidates.map(candidate => candidate.pluginId), candidates };
  }
  if (input.metadata.pluginSelectionPolicy === "auto") {
    throw new Error("旧版自动插件输入缺少已保存的插件范围，请重新发送此消息（resubmit）");
  }
  if (runtime.pluginAutoSelectionEnabled === false) return none();
  // Legacy ordinary inputs without a saved decision stay in baseline scope.
  return none();
}
