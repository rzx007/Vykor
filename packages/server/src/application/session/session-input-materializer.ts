import type { ContentBlock } from "@openharness/core";
import {
  normalizeSessionUserInputItems,
  sessionUserInputText,
  type SessionUserInputItem,
} from "@openharness/protocol";

export interface SessionInputCatalogSkill {
  name: string;
  path: string;
  displayName?: string;
  source?: "bundled" | "user" | "project" | "plugin";
}

/** The cwd-scoped catalog used to confirm renderer-provided skill paths. */
export interface SessionInputSkillCatalog {
  resolvePath(path: string): SessionInputCatalogSkill | undefined;
}

export interface SessionInputConversationCatalog {
  resolveConversation(id: string): { id: string; title: string; summary: string } | undefined;
}

export interface MaterializedSessionInput {
  text: string;
  skills: SessionInputCatalogSkill[];
  instruction: string;
  conversations: Array<{ id: string; title: string; summary: string }>;
  agents?: string[];
}

/**
 * Convert durable structured input into the one text-only adapter used by the
 * current agent runtime.  Every explicit path must still be a current catalog
 * winner, so a stale renderer reference cannot cause an arbitrary file read.
 */
export function materializeSessionInput(
  input: readonly SessionUserInputItem[],
  catalog: SessionInputSkillCatalog,
  conversationCatalog?: SessionInputConversationCatalog,
): MaterializedSessionInput {
  const items = normalizeSessionUserInputItems(input);
  const text = sessionUserInputText(items);
  const skills: SessionInputCatalogSkill[] = [];
  const paths = new Set<string>();
  const conversations: Array<{ id: string; title: string; summary: string }> = [];
  const conversationIds = new Set<string>();
  const agents = [...new Set(items.flatMap((item) => item.type === "capability" && item.kind === "plugin_agent" ? [item.agentId] : []))];

  for (const item of items) {
    if (item.type === "context") {
      const conversation = conversationCatalog?.resolveConversation(item.id);
      if (!conversation) throw new Error("session_input_conversation_not_found");
      if (!conversationIds.has(conversation.id)) {
        conversationIds.add(conversation.id);
        conversations.push(conversation);
      }
      continue;
    }
    if (item.type !== "skill") continue;
    const catalogSkill = catalog.resolvePath(item.path);
    if (!catalogSkill || catalogSkill.name !== item.name) {
      throw new Error("session_input_skill_catalog_mismatch");
    }
    if (paths.has(catalogSkill.path)) continue;
    paths.add(catalogSkill.path);
    skills.push(catalogSkill);
  }

  const prefix = [skillInstructionPrefix(skills), conversationInstructionPrefix(conversations), agentInstructionPrefix(agents)].filter(Boolean).join("\n\n");
  return {
    text,
    skills,
    conversations,
    agents,
    instruction: prefix ? `${prefix}\n\n用户输入：\n${text}` : text,
  };
}

function conversationInstructionPrefix(
  conversations: readonly { id: string; title: string; summary: string }[],
): string {
  if (conversations.length === 0) return "";
  return [
    "用户引用了以下历史对话作为只读参考上下文：",
    ...conversations.map((conversation, index) =>
      `${index + 1}. ${conversation.title}\n${conversation.summary}`
    ),
  ].join("\n");
}

/** Insert the single structured-skill instruction without disturbing attachments. */
export function applyMaterializedSessionInput(
  content: string | ContentBlock[],
  materialized: MaterializedSessionInput,
): string | ContentBlock[] {
  if (materialized.skills.length === 0 && materialized.conversations.length === 0 && !materialized.agents?.length) return content;
  const prefix = [
    skillInstructionPrefix(materialized.skills),
    conversationInstructionPrefix(materialized.conversations),
    agentInstructionPrefix(materialized.agents ?? []),
  ].filter(Boolean).join("\n\n");
  if (typeof content === "string") return `${prefix}\n\n用户输入：\n${content}`;
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex < 0) {
    return [{ type: "text", text: `${prefix}\n\n用户输入：\n` }, ...content];
  }
  return content.map((block, index) =>
    index === textIndex && block.type === "text"
      ? { ...block, text: `${prefix}\n\n用户输入：\n${block.text}` }
      : block,
  );
}

function skillInstructionPrefix(skills: readonly SessionInputCatalogSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：",
    ...skills.map((skill, index) => `${index + 1}. ${skill.name} (path: ${skill.path})`),
  ].join("\n");
}

function agentInstructionPrefix(agents: readonly string[]): string {
  if (agents.length === 0) return "";
  return [
    "用户选择了以下 Agent，请通过 Agent 工具委派用户任务（补充 description 和 prompt），使用 JobWait/JobRead 获取子任务结果后，由你给出最终回复：",
    ...agents.map((name) => JSON.stringify({ subagentType: name })),
  ].join("\n");
}
