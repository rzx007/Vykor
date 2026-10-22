export interface MemoryEntryRecord {
  id: string;
  content: string;
  tags?: string[];
  source?: {
    type: "user_message" | "manual_remember" | "manual_edit";
    sessionId?: string;
    messageSha256?: string;
  };
  createdAt: number;
  updatedAt: number;
  /** Content and metadata fingerprint, required for conflict-aware editing. */
  revision?: string;
}
export interface MemoryRevision {
  id: string;
  revision: string;
}
export interface UpdateMemoryEntryInput {
  cwd: string;
  id: string;
  content: string;
  expectedRevision: string;
}
export interface ClearMemoryInput {
  cwd: string;
  expectedEntries: MemoryRevision[];
}
