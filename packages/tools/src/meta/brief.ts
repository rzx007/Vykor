import type { ToolDefinition } from "@vykor/core";

export const briefTool: ToolDefinition = {
  name: "Brief",
  description: "Shorten a piece of text for compact display.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to shorten" },
      maxChars: { type: "number", description: "Maximum characters", default: 200, minimum: 20, maximum: 2000 },
    },
    required: ["text"],
  },
  async execute(input) {
    const text = (input.text as string).trim();
    const maxChars = Math.min(Math.max((input.maxChars as number) ?? 200, 20), 2000);
    if (text.length <= maxChars) {
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: text.slice(0, maxChars).trimEnd() + "..." }] };
  },
};
