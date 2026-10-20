/** 权限模式选项（/permissions 选择器与 Tab 循环共用）。 */
export const PERMISSION_MODES = [
  {
    value: "ask",
    label: "ask",
    description: "Ask for approval on sensitive operations",
  },
  {
    value: "auto_review",
    label: "auto_review",
    description: "Automatically review operations and ask when approval is needed",
  },
  {
    value: "full_access",
    label: "full_access",
    description: "Allow all operations without asking",
  },
] as const;

/** Tab 循环顺序（与 PERMISSION_MODES 的 value 对应）。 */
export const PERMISSION_MODE_ORDER = ["ask", "auto_review", "full_access"] as const;
