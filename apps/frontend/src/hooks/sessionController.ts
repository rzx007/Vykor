import type {
  McpServerSnapshot,
  SelectOptionPayload,
  TranscriptItem,
} from "../types";
import type { JobSnapshot, ModelProviderInfo, SessionModelRetryState, SessionModelUsageSummary } from "@vykor/client";
import type { JobDetailRemoteState, JobRemoteState } from "../jobs/job-remote-state";

export type JobRequestAction =
  | { type: "job_request"; job_action: "open" | "refresh" }
  | { type: "job_request"; job_action: "select"; job_id: string }
  | { type: "job_request"; job_action: "cancel"; job_id: string; reason?: string }
  | { type: "job_request"; job_action: "send"; job_id: string; data: string };

export type TuiAction =
  | { type: "select_model"; model: string; provider?: string }
  | { type: "submit_line"; line: string }
  | { type: "delete_session"; session_id: string }
  | { type: "interrupt" }
  | { type: "permission_response"; request_id: string; allowed: boolean; scope?: "session" | "once" }
  | { type: "question_response"; request_id: string; answer: string }
  | { type: "list_sessions" }
  | { type: "set_permission_mode"; permission_mode: "default" | "plan" | "full_auto" }
  | { type: "set_session_mode"; session_mode: "coordinator" | "direct" }
  | JobRequestAction;

export type TuiSessionController = {
  transcript: TranscriptItem[];
  assistantBuffer: string;
  retry?: SessionModelRetryState;
  usage?: SessionModelUsageSummary;
  knownUsage?: { inputTokens: number; outputTokens: number };
  status: Record<string, unknown>;
  jobState: JobRemoteState;
  jobs: JobSnapshot[];
  jobDetailState: JobDetailRemoteState;
  commands: string[];
  commandDetails: Array<{ name: string; description?: string }>;
  mcpServers: McpServerSnapshot[];
  modal: Record<string, unknown> | null;
  selectRequest: {
    title: string;
    submitPrefix: string;
    options: SelectOptionPayload[];
  } | null;
  displayRequest: {
    key?: string;
    title: string;
    content: string;
  } | null;
  busy: boolean;
  ready: boolean;
  setModal(value: Record<string, unknown> | null): void;
  setSelectRequest(value: TuiSessionController["selectRequest"]): void;
  setDisplayRequest(value: TuiSessionController["displayRequest"]): void;
  setBusy(value: boolean): void;
  loadModels(): Promise<ModelProviderInfo[]>;
  sendRequest(action: TuiAction): void;
};
