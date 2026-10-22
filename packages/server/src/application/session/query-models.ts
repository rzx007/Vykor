import type { SessionRecord, SessionInputRecord, SessionMessageRecord, SessionMessagePartRecord, SessionRunRecord, SessionRunAttemptRecord, PermissionRequestRecord, SessionExecutionRecord } from "@vykor/domain-contracts/sessions";
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
