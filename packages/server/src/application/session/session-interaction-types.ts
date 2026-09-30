import type {
  AppendEventInput,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionUserInputItem,
} from "@vykor/protocol";
import type { AdmitPromptAttachmentInput } from "@vykor/protocol";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import type { DaemonOperationGate } from "../control/daemon-operation-gate.js";
import type { AdmitPromptResult, RunAdmissionService } from "./run-admission-service.js";
import type { RunControlService } from "./run-control-service.js";
import type { SessionOperationRunner } from "./session-operation-runner.js";
import type { SessionRunExecutorContext } from "./session-run-executor.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";

export interface SessionInteractionSessions {
  get(sessionId: string): SessionRecord | undefined;
  listChildren(sessionId: string): SessionRecord[];
}

export interface SessionInteractionConversations {
  getInput(inputId: string): SessionInputRecord | undefined;
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(sessionId: string): SessionMessagePartRecord[];
  appendEvent(input: AppendEventInput): unknown;
}

export interface SessionInteractionRuns {
  getRun(runId: string): SessionRunRecord | undefined;
  findRunByInput(inputId: string): SessionRunRecord | undefined;
  listRunsByInput(inputId: string): SessionRunRecord[];
  updateRun(runId: string, input: Partial<SessionRunRecord>): SessionRunRecord;
}

export interface SessionInteractionServiceContext {
  sessions: SessionInteractionSessions;
  conversations: SessionInteractionConversations;
  runs: SessionInteractionRuns;
  admission: Pick<RunAdmissionService, "admitPromptAndMaybeRun" | "replaceLatestPrompt" | "replayInput">;
  control: Pick<RunControlService, "hasWork" | "interruptRun" | "interruptSession" | "interruptQueuedRun" | "promoteQueuedRun">;
  operationRunner: Pick<SessionOperationRunner, "run">;
  agentPool: Pick<AgentPool, "close" | "configured" | "warm">;
  liveChildren: Pick<LiveChildAgentDirectory, "has" | "send" | "interrupt">;
  operationGate: Pick<DaemonOperationGate, "enter">;
  resolveSkillCatalog?: SessionRunExecutorContext["resolveSkillCatalog"];
  pluginCapabilities?: Pick<SessionPluginCapabilityService, "admit">;
}

export interface EditLatestPromptInput {
  id: string;
  items: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
  sourceMessageId: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export interface ResumeRunInput {
  id?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export interface PromoteQueuedPromptInput {
  queuedRunId: string;
  expectedActiveRunId: string;
}

export interface CancelQueuedPromptInput {
  queuedRunId: string;
}

export type ResumeRunResult = AdmitPromptResult & {
  source_run: SessionRunRecord;
};
