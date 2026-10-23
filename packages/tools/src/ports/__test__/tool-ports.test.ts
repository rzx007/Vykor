import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vykor/agent-contracts";
import { createConfigTool } from "../../meta/config.js";
import { createSkillTools, skillCatalogSnapshot } from "../../meta/skill.js";
import { createMcpTools } from "../../mcp/mcp-tools.js";
import type { McpToolPort } from "../mcp.js";

const context: ToolContext = {
  cwd: "/repo",
  sessionId: "owner",
  abortSignal: new AbortController().signal,
};

describe("injected tool ports", () => {
  it("reads and writes configuration through the supplied receiver", async () => {
    const port = {
      values: { outputStyle: "initial" },
      async read() {
        return this.values;
      },
      async set(key: string, value: string) {
        Object.assign(this.values, { [key]: value });
      },
    };
    const tool = createConfigTool(port);
    await tool.execute(
      { action: "set", key: "outputStyle", value: "updated" },
      context,
    );
    expect(port.values.outputStyle).toBe("updated");
    expect(
      JSON.stringify(await tool.execute({ action: "show" }, context)),
    ).toContain("updated");
    expect((await createConfigTool().execute({}, context)).isError).toBe(true);
  });

  it("does not discover a Skill from context when its port is missing", async () => {
    const definition = { name: "private", description: "private summary", content: "private body", path: "", userInvocable: true, disableModelInvocation: false };
    const result = await createSkillTools().find(tool => tool.name === "Skill")!.execute({ name: "private" }, {
      ...context, capabilityView: { skills: new Map([["private", { definition, path: "" }]]), tools: new Map(), agents: new Map(), mcpServers: new Map() },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private body");
  });

  it("loads Skill content only from the supplied catalogue", async () => {
    const port = {
      calls: 0,
      async resolve(received: ToolContext) {
        expect(received).toBe(context);
        this.calls += 1;
        return skillCatalogSnapshot([
          {
            name: "review",
            description: "review",
            content: "captured content",
            path: "",
            userInvocable: true,
            disableModelInvocation: false,
          },
        ]);
      },
    };
    const tool = createSkillTools(port).find((tool) => tool.name === "Skill")!;
    expect(
      JSON.stringify(await tool.execute({ name: "review" }, context)),
    ).toContain("captured content");
    expect(port.calls).toBe(1);
  });

  it("keeps the MCP port receiver and forwards the actual invocation context", async () => {
    const port: McpToolPort & { value: string } = {
      value: "host response",
      listResources(received) {
        expect(received).toBe(context);
        return [
          { serverName: "server", uri: "resource://one", name: this.value },
        ];
      },
      async readResource(server, uri, received) {
        expect([server, uri]).toEqual(["server", "resource://one"]);
        expect(received.abortSignal).toBe(context.abortSignal);
        return this.value;
      },
      async configureAuth(_input, received) {
        expect(received).toBe(context);
        return { message: this.value };
      },
    };
    const tools = createMcpTools(port);
    for (const [name, input] of [
      ["ListMcpResources", {}],
      ["ReadMcpResource", { serverName: "server", uri: "resource://one" }],
      ["McpAuth", { serverName: "server", mode: "bearer", value: "secret" }],
    ] as const) {
      expect(
        JSON.stringify(
          await tools
            .find((tool) => tool.name === name)!
            .execute(input, context),
        ),
      ).toContain("host response");
    }
    expect(
      (
        await createMcpTools()
          .find((tool) => tool.name === "ReadMcpResource")!
          .execute({}, context)
      ).isError,
    ).toBe(true);
  });
});
