import type { ToolDefinition } from "@openharness/core";

export const enterPlanModeTool: ToolDefinition = {
  name: "EnterPlanMode",
  description: "Switch permission mode to plan.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const { updateSettings } = await import("@openharness/core");
    await updateSettings((settings) => ({
      ...settings,
      permission: { ...settings.permission, mode: "plan" },
    }));
    return { content: [{ type: "text", text: "Permission mode set to plan" }] };
  },
};

export const exitPlanModeTool: ToolDefinition = {
  name: "ExitPlanMode",
  description: "Switch permission mode back to default.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const { updateSettings } = await import("@openharness/core");
    await updateSettings((settings) => ({
      ...settings,
      permission: { ...settings.permission, mode: "default" },
    }));
    return { content: [{ type: "text", text: "Permission mode set to default" }] };
  },
};
