export type HookEvent =
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "post_compact"
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
  | "notification"
  | "stop"
  | "subagent_stop";

/** All hook events, aligned with Python `HookEvent` enum. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "session_start",
  "session_end",
  "pre_compact",
  "post_compact",
  "pre_tool_use",
  "post_tool_use",
  "user_prompt_submit",
  "notification",
  "stop",
  "subagent_stop",
];

export interface HookResult {
  blocked: boolean;
  reason?: string;
}
