import type {
  AppendEventInput,
  CreatePermissionRequestInput,
  ListPermissionRequestsOptions,
  PermissionRequestRecord,
  SessionEventRecord,
  SessionRecord,
  SessionRunRecord,
} from "@openharness/protocol";

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
