export type FrontendConfig = {
  daemon?: {
    url: string;
    token?: string | null;
    cwd?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    maxTurns?: number | null;
    sessionMode?: string | null;
    pluginsEnabled?: boolean | null;
  } | null;
  initial_prompt?: string | null;
  theme?: string | null;
  version?: string | null;
};

export type TranscriptItem = {
  id?: string;
  role: "system" | "user" | "assistant" | "reasoning" | "tool" | "tool_result" | "log";
  text: string;
  streaming?: boolean;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
};

export type McpServerSnapshot = {
  name: string;
  state: string;
  detail?: string;
  transport?: string;
  auth_configured?: boolean;
  tool_count?: number;
  resource_count?: number;
};

export type BridgeSessionSnapshot = {
  session_id: string;
  command: string;
  cwd: string;
  pid: number;
  status: string;
  started_at: number;
  output_path: string;
};

export type SelectOptionPayload = {
  value: string;
  label: string;
  description?: string;
};
