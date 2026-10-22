import type { PermissionStatus } from "@vykor/domain-contracts/sessions";
export interface CreatePermissionRequestInput {
  id?: string;
  sessionId: string;
  runId?: string;
  toolName: string;
  payload?: Record<string, unknown>;
}

export interface ReplyPermissionInput {
  requestId: string;
  status: Extract<PermissionStatus, "approved" | "denied" | "expired">;
  decision?: string;
  clientId?: string;
  answer?: string;
}

export interface ListPermissionRequestsOptions {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}
