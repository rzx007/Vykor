import type { SessionStorage } from "@vykor/domain-contracts/sessions";
export interface CreateSessionInput {
  id?: string;
  storage?: SessionStorage;
  parentId?: string;
  projectId?: string;
  cwd: string;
  title?: string;
  model: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateSessionInput {
  title?: string;
  model?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Narrow maintenance input: clear only a matching, already-removed worktree binding. */
export interface ClearSessionWorktreeBindingInput {
  id: string;
  path: string;
  branch: string;
}

export interface ListSessionsOptions {
  cwd?: string;
  includeArchived?: boolean;
  limit?: number;
}
