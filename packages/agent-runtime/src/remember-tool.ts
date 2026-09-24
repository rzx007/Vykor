import type { ToolDefinition } from "@vykor/core";
import type { MemoryManager } from "@vykor/memory";

export interface RememberToolOptions {
  appendUserProfile(content: string): Promise<string>;
  projectMemory?: MemoryManager;
}

export function createRememberTool(options: RememberToolOptions): ToolDefinition {
  return {
    name: "Remember",
    description:
      "Persist something the user explicitly asked you to remember. Use scope=user for cross-project user preferences and stable personal information. Use scope=project for knowledge needed in later sessions of the current project. Never use Write or Edit for managed memory files.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Where this memory should apply.",
        },
        content: {
          type: "string",
          description: "The concise preference or durable fact to remember.",
        },
      },
      required: ["scope", "content"],
    },
    async execute(input) {
      const scope = input.scope;
      const content = typeof input.content === "string" ? input.content.trim() : "";

      if (scope !== "user" && scope !== "project") {
        return toolError("Remember scope must be either user or project.");
      }
      if (!content) {
        return toolError("Remember content must not be empty.");
      }

      try {
        if (scope === "user") {
          await options.appendUserProfile(content);
          return {
            content: [{ type: "text", text: "Remembered this user preference." }],
            metadata: { scope },
          };
        }

        if (!options.projectMemory) {
          return toolError("Project memory is disabled for this agent.");
        }
        const entry = await options.projectMemory.add(content);
        return {
          content: [{ type: "text", text: "Remembered this project information." }],
          metadata: { scope, entryId: entry.id },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}
