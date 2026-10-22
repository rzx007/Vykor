import type { RunAttemptStatus, RunStatus, SessionTaskStatus } from "@vykor/domain-contracts/sessions";
export interface CreateRunInput {
  id?: string;
  sessionId: string;
  inputId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRunInput {
  status?: RunStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunAttemptInput {
  id?: string;
  runId: string;
  sequence?: number;
  provider?: string;
  model?: string;
  retryReason?: string;
}

export interface UpdateRunAttemptInput {
  status?: RunAttemptStatus;
  errorKind?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CreateSessionTaskInput {
  id?: string;
  sessionId: string;
  childSessionId?: string;
  runId?: string;
  type: string;
  description: string;
  cwd: string;
  status?: SessionTaskStatus;
  requestNamespace?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateSessionTaskInput {
  status?: SessionTaskStatus;
  runId?: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
