import type { MemoryEntryRecord } from "@vykor/protocol";

export interface ProjectFactRecord {
  key: string;
  type: string;
  label: string;
  value: string;
  confidence: number;
  observedAt?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  status?: "superseded";
  replacement?: { byKey: string; operationId: string; at: string };
  manualSource?: { kind: "manual_replace"; operationId: string; oldKey: string; at: string; sessionId?: string };
}

export interface FactReplacementResult {
  oldKey: string;
  newKey: string;
  operationId: string;
  relatedActiveKeys: string[];
  cacheWarning?: string;
}

export interface MemoryListResponse {
  directory: string;
  entries: MemoryEntryRecord[];
}

export interface StartDreamResponse {
  taskId: string;
}
