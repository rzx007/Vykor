import type { AgentRunScope, ToolDispatchCheckFactory } from "@vykor/agent-contracts";
import { readSessionRuntimeRevision } from "@vykor/domain-contracts/sessions";
import type { ApplicationOwnerLease, SessionStore } from "@vykor/services";
export function bindToolDispatchCheck(options: {
  store: Pick<SessionStore, "assertApplicationOwner" | "sessions" | "runs">;
  ownerLease(): ApplicationOwnerLease; accepting(): boolean;
}): ToolDispatchCheckFactory {
  const current = (scope: AgentRunScope): number => {
    options.store.assertApplicationOwner(options.ownerLease());
    if (!options.accepting() || scope.signal.aborted) throw new Error("Tool Run no longer accepts dispatch");
    const session = options.store.sessions.get(scope.sessionId), run = options.store.runs.getRun(scope.runId);
    if (!session || session.status === "closing" || session.status === "archived" || scope.agentId !== session.id || scope.cwd !== session.cwd
      || !run || run.sessionId !== session.id || (run.inputId !== undefined && run.inputId !== scope.inputId)
      || (run.status !== "pending" && run.status !== "running")) throw new Error("Tool Run does not belong to the current session or is terminal");
    return readSessionRuntimeRevision(session.metadata);
  };
  return (scope, tools) => {
    const captured = { ...scope }, revision = current(captured);
    const bindings = new Map([...tools].map(([name, binding]) => [name, { ...binding, source: binding.source && { ...binding.source }, execute: binding.definition.execute }]));
    return ({ scope: actual, toolUse, binding, cwd }) => {
      if (current(captured) !== revision) throw new Error("Tool policy changed since Run capture");
      if (actual.agentId !== captured.agentId || actual.sessionId !== captured.sessionId || actual.runId !== captured.runId || actual.inputId !== captured.inputId || actual.cwd !== captured.cwd || cwd !== captured.cwd || actual.signal.aborted) throw new Error("Tool scope changed before dispatch");
      const expected = bindings.get(toolUse.name);
      if (!expected || !binding || expected.definition !== binding.definition || expected.definitionIdentity !== binding.definitionIdentity || expected.invoke !== binding.invoke
        || expected.execute !== binding.definition.execute || expected.source?.kind !== binding.source?.kind || expected.source?.id !== binding.source?.id) throw new Error("Tool binding changed before dispatch");
      if (!toolUse.input || typeof toolUse.input !== "object" || Array.isArray(toolUse.input)) throw new Error("Tool input is invalid");
    };
  };
}
