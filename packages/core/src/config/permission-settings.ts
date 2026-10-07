import type { PermissionSettings } from "../types/settings.js";

/** Validate the shared persisted format before any host writes permission rules. */
export function parsePermissionSettings(value: unknown): PermissionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("权限设置必须是对象。");
  const settings = value as Record<string, unknown>;
  const fields = [
    "mode",
    "allowedTools",
    "deniedTools",
    "pathRules",
    "deniedCommands",
    "autoApproveTools",
  ];
  if (Object.keys(settings).some((key) => !fields.includes(key)))
    throw new Error("权限设置包含未知字段。");
  if (
    typeof settings.mode !== "string" ||
    !["default", "plan", "full_auto"].includes(settings.mode)
  )
    throw new Error("请选择有效的批准方式。");
  for (const key of [
    "allowedTools",
    "deniedTools",
    "deniedCommands",
    "autoApproveTools",
  ]) {
    const list = settings[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      throw new Error(`${key} 必须是非空文本组成的列表。`);
    }
  }
  if (
    settings.pathRules !== undefined &&
    (!Array.isArray(settings.pathRules) ||
      settings.pathRules.some(
        (rule) =>
          !rule ||
          typeof rule !== "object" ||
          Array.isArray(rule) ||
          typeof rule.pattern !== "string" ||
          !rule.pattern.trim() ||
          typeof rule.allow !== "boolean" ||
          Object.keys(rule).some((key) => key !== "pattern" && key !== "allow"),
      ))
  ) {
    throw new Error("路径规则必须包含非空路径和允许或禁止选项。");
  }
  return structuredClone(settings) as unknown as PermissionSettings;
}
