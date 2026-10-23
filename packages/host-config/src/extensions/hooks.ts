import type { HookExecutor } from "@vykor/agent-contracts";
import type { HookEvent } from "@vykor/agent-contracts";

export type HookType = "command" | "http" | "prompt" | "agent";

interface HookDefinitionBase {
  id: string;
  event: HookEvent;
  enabled: boolean;
  timeout?: number;
  /** fnmatch/glob-style matcher against the event subject (tool name / prompt / event). */
  matcher?: string;
  /** Higher priority runs first within an event; ties keep registration order. */
  priority?: number;
  /** Whether a failed/rejecting hook blocks continuation. */
  blockOnFailure?: boolean;
}

export interface CommandHookDefinition extends HookDefinitionBase {
  type: "command";
  command: string;
}

export interface HttpHookDefinition extends HookDefinitionBase {
  type: "http";
  url: string;
  method?: string;
}

export interface PromptHookDefinition extends HookDefinitionBase {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface AgentHookDefinition extends HookDefinitionBase {
  type: "agent";
  prompt: string;
  model?: string;
}

export type HookDefinition =
  | CommandHookDefinition
  | HttpHookDefinition
  | PromptHookDefinition
  | AgentHookDefinition;

/** Host registration is separate from the generic execute boundary. */
export interface RegisteredHookExecutor extends HookExecutor {
  register(hook: HookDefinition): void;
  getAll?(): readonly HookDefinition[];
  unregister?(hookId: string): void;
}
