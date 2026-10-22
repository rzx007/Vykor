import { describe, expect, it, vi } from "vitest";
import type { McpAuthHost } from "@vykor/tools";
import type { ToolResult } from "@vykor/agent-contracts";
import { createMcpTools } from "../index.js";

function textOf(result: ToolResult): string {
  return result.content.map(block => block.type === "text" ? block.text : "").join("\n");
}

function authTool(host?: McpAuthHost) {
  return createMcpTools(host ? {
    listResources: () => undefined,
    readResource: async () => { throw new Error("Resources unavailable"); },
    configureAuth: input => host.configure(input),
  } : undefined).find(tool => tool.name === "McpAuth")!;
}

describe("McpAuth", () => {
  it("does not claim success when the host cannot save and reconnect MCP auth", async () => {
    const configure = vi.fn(async () => ({ message: "must not save" }));
    const result = await authTool().execute({ serverName: "remote", mode: "bearer", value: "tok" }, {
      cwd: process.cwd(), mcpAuth: { configure },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No auth was saved");
    expect(configure).not.toHaveBeenCalled();
  });

  it("delegates auth updates to the injected host effect", async () => {
    const configure = vi.fn(async () => ({ message: "saved and reconnected" }));
    const result = await authTool({ configure }).execute({
      serverName: "remote", mode: "header", key: "X-API-Key", value: "secret",
    }, { cwd: process.cwd() });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("saved and reconnected");
    expect(configure).toHaveBeenCalledWith({ serverName: "remote", mode: "header", key: "X-API-Key", value: "secret" });
  });

  it("returns injected host failures to the model", async () => {
    const result = await authTool({ configure: async () => { throw new Error("env only works for stdio"); } }).execute({
      serverName: "remote", mode: "env", value: "secret",
    }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("env only works for stdio");
  });
});
