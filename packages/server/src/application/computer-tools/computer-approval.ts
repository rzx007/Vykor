import type { ApprovalMode } from "@vykor/agent-contracts/permissions";
import { readRuntimeMetadata, readSessionRuntimeRevision, type SessionRecord } from "@vykor/domain-contracts/sessions";
import { normalizeApprovalMode, type Settings } from "@vykor/host-config";
import type { SessionStore } from "@vykor/services";
import type { StorePermissionBroker } from "../../permissions/permission-broker.js";
import { sessionPermissionRequest } from "../../permissions/session-approval.js";
import { isRecord, jsonEqual } from "../support.js";
import type { ComputerApprovalAccess } from "./computer-bridge.js";
import type { ComputerRunIdentity } from "./computer-bridge-protocol.js";

/** Capture daemon-owned input evidence when dispatch starts, before Desktop asks for consent. */
export function captureComputerApproval(
  store: SessionStore,
  broker: Pick<StorePermissionBroker, "askComputer" | "replyComputer">,
  scope: ComputerRunIdentity,
  resolveSettings?: (session: SessionRecord) => Promise<Settings | undefined>,
): ComputerApprovalAccess | undefined {
  const session = store.sessions.get(scope.sessionId);
  const run = store.runs.getRun(scope.runId);
  if (!session || !run || run.sessionId !== scope.sessionId || run.inputId !== scope.inputId) return;
  const runtimeRevision = readSessionRuntimeRevision(session.metadata);
  const runtime = readRuntimeMetadata(session.metadata);
  const selectedMode = normalizeApprovalMode(runtime.approvalMode ?? runtime.permissionMode);
  const appliedInput = structuredClone(run.metadata.appliedInputState);
  const traceId = typeof run.metadata.traceId === "string" ? run.metadata.traceId : undefined;
  let settings: Promise<Settings | undefined> | undefined;
  const getSettings = () => settings ??= resolveSettings?.(session) ?? Promise.resolve(undefined);
  const mode = async (): Promise<ApprovalMode> => selectedMode
    ?? normalizeApprovalMode((await getSettings())?.permission.mode) ?? "ask";
  const isOriginalScope = () => {
    const session = store.sessions.get(scope.sessionId);
    const run = store.runs.getRun(scope.runId);
    const runtime = readRuntimeMetadata(session?.metadata);
    return !!session && session.status !== "closing" && session.status !== "archived"
      && readSessionRuntimeRevision(session.metadata) === runtimeRevision
      && normalizeApprovalMode(runtime.approvalMode ?? runtime.permissionMode) === selectedMode
      && !!run && run.status === "running" && run.sessionId === scope.sessionId
      && run.inputId === scope.inputId && jsonEqual(appliedInput, run.metadata.appliedInputState);
  };
  return {
    isOriginalScope,
    isFullAccess: async () => await mode() === "full_access",
    async ask(proposal, action, signal, pendingIsCurrent, register) {
      const isCurrent = () => !signal.aborted && pendingIsCurrent() && isOriginalScope();
      if (!isCurrent()) return false;
      const approvalMode = await mode();
      if (!isCurrent()) return false;
      if (approvalMode === "full_access") return true;
      const { type, ...args } = action;
      const input = { ...scope, signal, isCurrent, traceId, runtimeRevision, reason: proposal.reason, approvalMode,
        input: { action: type, ...args } };
      if (approvalMode === "auto_review") {
        const settings = await getSettings();
        if (!isCurrent()) return false;
        const appliedInputState = isRecord(appliedInput) && typeof appliedInput.revision === "number"
          && Array.isArray(appliedInput.inputIds) && appliedInput.inputIds.every(id => typeof id === "string")
          ? { revision: appliedInput.revision, inputIds: appliedInput.inputIds } : undefined;
        const { review } = sessionPermissionRequest({
          store, settings, outsideSandbox: true,
          request: {
            toolName: "Computer", toolSource: "agent", reason: proposal.reason,
            ...(type === "click" ? { toolDescription: "A coordinate identifies only a location in the current window. The clicked control and its effects need independent UI evidence." } : {}),
          },
          context: {
            ...scope, signal, approvalMode, appliedInputState, cwd: session.cwd,
            agentId: session.agent ?? "main", traceId: traceId ?? scope.runId,
          },
        });
        const decision = await broker.askComputer({ ...input, review }, register);
        return decision.status === "approved" && isCurrent();
      }
      const decision = await broker.askComputer(input, register);
      return decision.status === "approved" && isCurrent();
    },
    reply: input => broker.replyComputer(input),
  };
}
