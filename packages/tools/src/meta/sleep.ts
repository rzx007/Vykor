import type { ToolDefinition } from "@vykor/core";

export const sleepTool: ToolDefinition = {
  name: "Sleep",
  description: "Sleep for a short duration (0-30 seconds).",
  inputSchema: {
    type: "object",
    properties: {
      seconds: { type: "number", description: "Duration in seconds", default: 1.0, minimum: 0, maximum: 30 },
    },
    required: [],
  },
  async execute(input) {
    const seconds = Math.min(Math.max((input.seconds as number) ?? 1.0, 0), 30);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { content: [{ type: "text", text: `Slept for ${seconds} seconds` }] };
  },
};
