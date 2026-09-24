import type { ToolDefinition } from "@vykor/core";

export const teamCreateTool: ToolDefinition = {
  name: "TeamCreate",
  description: "Create a lightweight in-memory team for agent tasks.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Team name" },
      description: { type: "string", description: "Team description" },
    },
    required: ["name"],
  },
  async execute(input) {
    const { getTeamRegistry } = await import("@vykor/coordinator");
    try {
      const team = getTeamRegistry().createTeam(input.name as string, (input.description as string) ?? "");
      return { content: [{ type: "text", text: `Created team ${team.name}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const teamDeleteTool: ToolDefinition = {
  name: "TeamDelete",
  description: "Delete an in-memory team.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Team name" } },
    required: ["name"],
  },
  async execute(input) {
    const { getTeamRegistry } = await import("@vykor/coordinator");
    try {
      getTeamRegistry().deleteTeam(input.name as string);
      return { content: [{ type: "text", text: `Deleted team ${input.name}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};
