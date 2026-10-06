import type { ToolDefinition } from "@vykor/core";

export const enterPlanModeTool: ToolDefinition = {
  name: "EnterPlanMode",
  description: "Narrow this runtime instance to read-only planning and analysis. Persists while this instance is alive; does not change user or global settings.",
  serialGroup: "permission-mode",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, context) {
    if (!context.setPlanMode) return { isError: true, content: [{ type: "text", text: "Current runtime mode control is unavailable; settings were not changed." }] };
    context.setPlanMode(true);
    return { content: [{ type: "text", text: "This runtime instance is now read-only (plan). User and global settings were not changed." }] };
  },
};

export const exitPlanModeTool: ToolDefinition = {
  name: "ExitPlanMode",
  description: "Restore this runtime instance's user-selected permission ceiling after temporary planning. Cannot exit user-selected plan mode; does not change persisted settings.",
  serialGroup: "permission-mode",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, context) {
    if (!context.setPlanMode) return { isError: true, content: [{ type: "text", text: "Current runtime mode control is unavailable; settings were not changed." }] };
    const mode = context.setPlanMode(false);
    return { isError: mode === "plan", content: [{ type: "text", text: mode === "plan"
      ? "The user-selected plan ceiling remains read-only; this tool cannot raise it. Persisted settings were not changed."
      : `This runtime instance restored its user-selected ${mode} ceiling. Persisted settings were not changed.` }] };
  },
};
