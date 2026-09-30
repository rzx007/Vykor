import { parse as parseYaml } from "yaml";

/**
 * 解析后的技能元数据接口。
 */
export interface ParsedSkillMeta {
  name: string;
  description: string;
  /** 缺省 true（对齐 Python user_invocable=True）。 */
  userInvocable: boolean;
  /** 缺省 false（对齐 Python disable_model_invocation=False）。 */
  disableModelInvocation: boolean;
  model?: string;
  argumentHint?: string;
  commandName?: string;
  displayName?: string;
}

/**
 * 解析 frontmatter 布尔值。true/1/yes/on → true，false/0/no/off → false。
 * 无法识别时返回 fallback。
 */
function parseFrontmatterBool(raw: string, fallback: boolean): boolean {
  const v = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * 把 frontmatter 的 key 归一化：去掉连字符/下划线差异，统一小写。
 * 例如 `user-invocable` 和 `user_invocable` 都归一为 `userinvocable`。
 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, "");
}

/**
 * 从 Markdown 内容中解析技能的名称和描述。
 * 支持 Frontmatter 格式（--- 包裹的 YAML 头部）提取元数据。
 * 如果没有 Frontmatter，则尝试从第一个标题或第一段文本中提取。
 *
 * @param defaultName - 默认的名称，通常由文件名生成，当内容中未指定名称时使用。
 * @param content - Markdown 文件的完整内容字符串。
 * @returns 包含解析后的 name 和 description 的对象。
 */
export function parseSkillMarkdown(
  defaultName: string,
  content: string
): ParsedSkillMeta {
  let name = defaultName;
  let description = "";
  let bodyStart = 0;

  // 扩展字段（带默认值，对齐 Python）
  let userInvocable = true;
  let disableModelInvocation = false;
  let model: string | undefined;
  let argumentHint: string | undefined;
  let commandName: string | undefined;
  let displayName: string | undefined;

  // 尝试解析 Frontmatter 部分
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const lines = content.split("\n");
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      const frontmatter = parseYamlRecord(lines.slice(1, endIdx).join("\n"));
      for (const [rawKey, rawValue] of Object.entries(frontmatter)) {
        const key = normalizeKey(rawKey);
        const val = frontmatterString(rawValue);
        switch (key) {
          case "name":
            if (val) name = val;
            break;
          case "description":
            if (val) description = val;
            break;
          case "userinvocable":
            userInvocable = parseFrontmatterBool(val, true);
            break;
          case "disablemodelinvocation":
            disableModelInvocation = parseFrontmatterBool(val, false);
            break;
          case "model":
            if (val) model = val;
            break;
          case "argumenthint":
            if (val) argumentHint = val;
            break;
          case "commandname":
            if (val) commandName = val;
            break;
          case "displayname":
            if (val) displayName = val;
            break;
        }
      }
      bodyStart = endIdx + 1;
    }
  }

  // 如果没有从 Frontmatter 获取到描述，则从正文中提取
  if (!description) {
    const lines = content.split("\n").slice(bodyStart);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ") && (name === defaultName || !name)) {
        name = trimmed.slice(2).trim() || name;
        continue;
      }
      if (trimmed.startsWith("---") || trimmed.startsWith("#") || trimmed === "") {
        continue;
      }
      description = trimmed.slice(0, 200);
      break;
    }
  }

  if (!description) description = `Skill: ${name}`;
  return {
    name,
    description,
    userInvocable,
    disableModelInvocation,
    model,
    argumentHint,
    commandName,
    displayName,
  };
}

function parseYamlRecord(source: string): Record<string, unknown> {
  try {
    const value = parseYaml(source);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function frontmatterString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return "";
}

/**
 * 支持的 Frontmatter 格式：
 *
---
name: git-workflow
description: Git 工作流程指南
userInvocable: true
disableModelInvocation: false
model: claude-3-opus
argumentHint: <branch-name>
commandName: git
displayName: Git 助手
---

# 实际内容...
 */
