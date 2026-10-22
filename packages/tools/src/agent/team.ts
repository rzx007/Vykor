import type { ToolDefinition } from "@vykor/core";
import type { TeamPort } from "@vykor/coordinator/teams";

export function createTeamTools(port: TeamPort): ToolDefinition[] {
  const teamCreateTool: ToolDefinition = {
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
      try {
        const team = port.createTeam(input.name as string, (input.description as string) ?? "");
        return { content: [{ type: "text", text: `Created team ${team.name}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  };

  const teamDeleteTool: ToolDefinition = {
    name: "TeamDelete",
    description: "Delete an in-memory team.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Team name" } },
      required: ["name"],
    },
    async execute(input) {
      try {
        port.deleteTeam(input.name as string);
        return { content: [{ type: "text", text: `Deleted team ${input.name}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  };

  return [teamCreateTool, teamDeleteTool];
}
