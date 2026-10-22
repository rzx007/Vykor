import type { AppendEventInput } from "../conversations/commands.js";
import type { CreatePermissionRequestInput, ListPermissionRequestsOptions } from "./commands.js";
import type { PermissionRequestRecord, SessionEventRecord, SessionRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";

import type { StorageContext } from "../database/storage-context.js";

export interface PermissionRepositoryOptions {
  storage: StorageContext;
  assertSession(sessionId: string): SessionRecord;
  getRun(runId: string): SessionRunRecord | undefined;
  appendEvent(input: AppendEventInput): SessionEventRecord;
}

export type {
  CreatePermissionRequestInput,
  ListPermissionRequestsOptions,
  PermissionRequestRecord,
};
