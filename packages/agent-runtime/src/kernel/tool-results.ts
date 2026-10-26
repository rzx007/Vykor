import type { PreparedAgentRun, RunToolBinding, RunToolResultStore } from "@vykor/agent-contracts";

/** Result access must use the same final definitions, sources and invokers as execution. */
export async function bindPreparedToolResults(
  prepared: PreparedAgentRun,
  tools: ReadonlyMap<string, RunToolBinding>,
): Promise<RunToolResultStore | undefined> {
  if (prepared.bindToolResults) return await prepared.bindToolResults(tools);
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
