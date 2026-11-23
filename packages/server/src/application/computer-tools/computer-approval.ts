import { readSessionRuntimeRevision } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import type { StorePermissionBroker } from "../../permissions/permission-broker.js";
import { jsonEqual } from "../support.js";
import type { ComputerApprovalAccess } from "./computer-bridge.js";
import type { ComputerRunIdentity } from "./computer-bridge-protocol.js";

/** Capture daemon-owned input evidence when dispatch starts, before Desktop asks for consent. */
export function captureComputerApproval(
  store: Pick<SessionStore, "runs" | "sessions">,
  broker: Pick<StorePermissionBroker, "askComputer" | "replyComputer">,
  scope: ComputerRunIdentity,
): ComputerApprovalAccess | undefined {
  const session = store.sessions.get(scope.sessionId);
  const run = store.runs.getRun(scope.runId);
  if (!session || !run || run.sessionId !== scope.sessionId || run.inputId !== scope.inputId) return;
  const runtimeRevision = readSessionRuntimeRevision(session.metadata);
  const appliedInput = structuredClone(run.metadata.appliedInputState);
  const traceId = typeof run.metadata.traceId === "string" ? run.metadata.traceId : undefined;
  const isOriginalScope = () => {
    const session = store.sessions.get(scope.sessionId);
    const run = store.runs.getRun(scope.runId);
    return !!session && session.status !== "closing" && session.status !== "archived"
      && readSessionRuntimeRevision(session.metadata) === runtimeRevision
      && !!run && run.status === "running" && run.sessionId === scope.sessionId
      && run.inputId === scope.inputId && jsonEqual(appliedInput, run.metadata.appliedInputState);
  };
  return {
    isOriginalScope,
    async ask(proposal, signal, pendingIsCurrent, register) {
      const isCurrent = () => !signal.aborted && pendingIsCurrent() && isOriginalScope();
      if (!isCurrent()) return false;
      const decision = await broker.askComputer({
        ...scope, signal, isCurrent, traceId, runtimeRevision, reason: proposal.reason,
      }, register);
      return decision.status === "approved" && isCurrent();
    },
    reply: input => broker.replyComputer(input),
  };
}
