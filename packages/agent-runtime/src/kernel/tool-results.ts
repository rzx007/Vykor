import type { PreparedAgentRun, RunToolBinding, RunToolResultStore } from "@vykor/agent-contracts";

/** Result access must use the same final definitions, sources and invokers as execution. */
export async function bindPreparedToolResults(
  prepared: PreparedAgentRun,
  tools: ReadonlyMap<string, RunToolBinding>,
  /** Deprecated trusted manual-call store; adapted here so callers share one binding path. */
  legacyManualStore?: RunToolResultStore,
): Promise<RunToolResultStore | undefined> {
  if (legacyManualStore) return legacyManualStore;
  if (prepared.bindToolResults) return await prepared.bindToolResults(tools);
  // Published prebound preparation contract: narrowing or replacement must close access.
  if (!prepared.toolResults) return undefined;
  if (tools.size !== prepared.tools.size) return undefined;
  for (const [name, binding] of tools) {
    const captured = prepared.tools.get(name);
    if (!captured
      || captured.definitionIdentity !== binding.definitionIdentity
      || captured.definition.execute !== binding.definition.execute
      || captured.invoke !== binding.invoke
      || captured.source?.kind !== binding.source?.kind
      || captured.source?.id !== binding.source?.id
      || (binding.definitionIdentity === undefined && captured.definition !== binding.definition)) return undefined;
  }
  return prepared.toolResults;
}
