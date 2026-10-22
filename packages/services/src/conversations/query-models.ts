import type { SessionRecord, SessionInputRecord, SessionMessageRecord, SessionMessagePartRecord, SessionRunRecord, SessionRunAttemptRecord, SessionExecutionRecord, PermissionRequestRecord } from "@vykor/domain-contracts/sessions";
/** Atomic, server-owned state used when a client attaches to one session. */
export interface SessionStateSnapshot {
  pluginApps?: import("@vykor/domain-contracts/plugin-apps").PluginAppRecord[];
  cursor: number;
  session: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  runs: SessionRunRecord[];
  attempts: SessionRunAttemptRecord[];
  tasks?: SessionExecutionRecord[];
  permissions: PermissionRequestRecord[];
}
