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
      if (!(key in settings)) {
        return { content: [{ type: "text", text: `Unknown config key: ${key}` }], isError: true };
      }
      await updateSettings((current) => ({ ...current, [key]: value }));
      return { content: [{ type: "text", text: `Updated ${key}` }] };
    }
    return { content: [{ type: "text", text: "Usage: action=show or action=set" }], isError: true };
  },
};
