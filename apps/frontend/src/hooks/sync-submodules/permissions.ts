import { selectFirstPendingPermission, type VykorClientState, type PermissionRequestRecord } from "@rzx/client";
import { isRecord } from "./view-model";

export function isAskUserRequest(request: PermissionRequestRecord): boolean {
  return request.toolName === "AskUser" && isRecord(request.payload.input) && request.payload.input.kind === "question";
}

export function permissionToModal(request: PermissionRequestRecord): Record<string, unknown> {
  const input = isRecord(request.payload.input) ? request.payload.input : {};
  const reason = typeof request.payload.reason === "string" ? request.payload.reason : null;
  if (isAskUserRequest(request)) {
    return {
      kind: "question",
      request_id: request.id,
      tool_name: request.toolName,
      question: typeof input.question === "string" ? input.question : reason,
      questions: input.questions,
    };
  }
  return {
    kind: "permission",
    request_id: request.id,
    tool_name: request.toolName,
    reason,
    input,
  };
}

export function firstPendingPermission(
  state: VykorClientState,
  sessionId?: string,
): PermissionRequestRecord | undefined {
  return selectFirstPendingPermission(state, sessionId);
}
