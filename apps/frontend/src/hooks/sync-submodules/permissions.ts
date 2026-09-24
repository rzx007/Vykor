import type { VykorClientState, PermissionRequestRecord } from "@vykor/client";
import { selectFirstPendingPermission } from "@vykor/client";

export function permissionToModal(request: PermissionRequestRecord): Record<string, unknown> {
  const input = request.payload.input && typeof request.payload.input === "object"
    ? (request.payload.input as Record<string, unknown>)
    : {};
  return {
    kind: "permission",
    request_id: request.id,
    tool_name: request.toolName,
    reason: typeof request.payload.reason === "string" ? request.payload.reason : null,
    input,
  };
}

export function firstPendingPermission(
  state: VykorClientState,
  sessionId?: string,
): PermissionRequestRecord | undefined {
  return selectFirstPendingPermission(state, sessionId);
}
