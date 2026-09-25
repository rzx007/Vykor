import type { ToolDefinition } from "@vykor/core";

export const configTool: ToolDefinition = {
  name: "Config",
  description: "Read or update Vykor settings.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "show or set", default: "show" },
      key: { type: "string", description: "Config key to set" },
      value: { type: "string", description: "Config value to set" },
    },
    required: [],
  },
  async execute(input) {
    const action = (input.action as string) ?? "show";
    const { loadSettings, updateSettings } = await import("@vykor/core");
    const settings = await loadSettings();
    if (action === "show") {
      return { content: [{ type: "text", text: JSON.stringify(settings, null, 2) }] };
    }
    if (action === "set") {
      const key = input.key as string;
      const value = input.value as string;
      if (!key || value === undefined) {
        return {
          content: [{ type: "text", text: "Usage: action=set with key and value" }],
          isError: true,
        };
      }
      // 只接受 settings 自身已有的键。`key in settings` 会连 Object.prototype 上的
      // 继承成员（constructor/toString 等）一起放行；把这类键写进 settings.json 后，
      // 之后每次 loadSettings() 都会因未知顶层字段抛 SettingsFileError。
      if (!Object.prototype.hasOwnProperty.call(settings, key)) {
        return { content: [{ type: "text", text: `Unknown config key: ${key}` }], isError: true };
      }
      await updateSettings((current) => ({ ...current, [key]: value }));
      return { content: [{ type: "text", text: `Updated ${key}` }] };
    }
    return { content: [{ type: "text", text: "Usage: action=show or action=set" }], isError: true };
  },
};
