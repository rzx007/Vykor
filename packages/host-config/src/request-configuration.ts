import type { WorkStyle } from "./settings-types.js";
/** The user-selected values that are safe to change between model requests. */
export type AgentRequestConfiguration = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
  effort?: string;
  maxTurns?: number;
  /** A session override takes precedence over settingsPrompt. */
  systemPrompt?: string;
  settingsPrompt?: string;
  workStyle?: WorkStyle;
  fastMode?: boolean;
};

export type AgentRequestConfigurationPatch = Partial<AgentRequestConfiguration>;

export type AgentRequestConfigurationSnapshot = {
  revision: number;
  configuration: Readonly<AgentRequestConfiguration>;
};

export interface AgentRequestConfigurationReader {
  read(): Promise<AgentRequestConfigurationSnapshot>;
}

export interface AgentRequestConfigurationStore extends AgentRequestConfigurationReader {
  update(
    patch: AgentRequestConfigurationPatch,
  ): Promise<AgentRequestConfigurationSnapshot>;
  restoreIfCurrent(
    failedRevision: number,
    previous: Readonly<AgentRequestConfiguration>,
  ): Promise<AgentRequestConfigurationSnapshot | undefined>;
}
