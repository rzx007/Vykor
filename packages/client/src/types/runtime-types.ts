/** Read-only descriptors for capabilities already available on the daemon. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  providerName: string;
  hint?: string;
  contextWindow?: number;
  outputLimit?: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  vision?: boolean;
  inputModalities?: string[];
  inputCapabilities?: { image: "native" | "unsupported" | "unknown" };
  toolCalling?: boolean;
  status?: "active" | "beta";
}

export interface ModelProviderInfo {
  name: string;
  displayName: string;
  models: ModelInfo[];
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount: number;
  command?: string;
  error?: string;
}

export type SkillSource = "bundled" | "agent" | "project" | "personal" | "standard";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  content: string;
  path: string;
  source: SkillSource;
  readOnly: boolean;
  projectPath?: string;
  projectName?: string;
}

export interface SkillProject {
  name: string;
  path: string;
}

export interface SkillSnapshot {
  skills: SkillInfo[];
  projects: SkillProject[];
  warnings: string[];
}

export interface AgentPersonaInfo {
  name: string;
  description: string;
  source?: string;
  model?: string;
}
