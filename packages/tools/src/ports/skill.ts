import type { ToolContext } from "@vykor/agent-contracts";

export interface ToolSkillDefinition {
  name: string;
  description: string;
  content: string;
  path: string;
  source?: "bundled" | "user" | "project" | "plugin";
  metadata?: Record<string, unknown>;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  commandName?: string;
  /** Set only by the host after selecting the winning plugin definition. */
  ownerPluginId?: string;
}

/** Supplies the current catalogue; discovery and filesystem refresh belong to the host. */
export interface SkillCatalogSnapshot {
  getAll(): readonly ToolSkillDefinition[];
  resolve(name: string): ToolSkillDefinition | undefined;
  resolvePath(path: string): ToolSkillDefinition | undefined;
}

export interface SkillCatalogPort {
  resolve(context: ToolContext): Promise<SkillCatalogSnapshot>;
}
