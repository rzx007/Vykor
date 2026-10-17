import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeSyncResult, Settings, ToolContext } from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import { buildMcpAuthServerSnapshot } from "@vykor/mcp";
import { McpConfigApplicationService } from "./mcp-config-application-service.js";
import { createMcpConfigureTool } from "./mcp-configure-tool.js";

const unavailable: McpRuntimeSyncResult = { status: "unavailable", affectedRuntimes: 0, failures: [] };
function world(sync: McpRuntimeSyncResult = unavailable) {
  let settings = { model: "m", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" }, mcpServers: {} } as Settings;
  const coordinator = { getStatus: async () => sync, synchronize: async () => sync, reconcileGlobal: vi.fn(async () => sync) };
  const service = new McpConfigApplicationService({
    loadSettings: async () => settings,
    updateSettings: async (change) => (settings = await change(settings)),
    coordinator,
    snapshot: async () => ({ servers: Object.entries(settings.mcpServers ?? {}).map(([name, config]) =>
      buildMcpAuthServerSnapshot({ name, config, credential: undefined, runtimeStatus: sync.status })) }),
  });
  const ask = vi.fn(async (_question: string) => "确认添加");
  return { tool: createMcpConfigureTool(service, "root"), coordinator, ask,
    context: { cwd: "/work", sessionId: "root", askUserPrompt: ask } as ToolContext,
    settings: () => settings };
}
const local = { action: "add", name: "blender", config: { type: "stdio", command: "uvx", args: ["--python", "3.11", "mcp-for-blender"] } };
const text = (result: Awaited<ReturnType<ReturnType<typeof createMcpConfigureTool>["execute"]>>) => JSON.stringify(result);

describe("McpConfigure", () => {
  it.each([
    JSON.stringify({ selected: {}, custom: { 0: "确认添加" } }),
    JSON.stringify({ selected: { 0: [0] }, custom: {} }),
  ])("accepts actual desktop confirmation replies: %s", async (answer) => {
    const w = world();
    w.ask.mockResolvedValue(answer);
    await w.tool.execute(local, w.context);
    expect(w.settings().mcpServers?.blender).toEqual(local.config);
    const prompt = JSON.parse(w.ask.mock.calls[0]![0]);
    expect(prompt.questions).toEqual([expect.objectContaining({ type: "radio", options: ["确认添加", "取消"] })]);
  });

  it.each([
    { selected: { 0: [1] }, custom: {} },
    { selected: {}, custom: {} },
    { selected: { 0: [0, 1] }, custom: {} },
    { selected: { 0: [0] }, custom: { 0: "取消" } },
  ])("never approves cancellation, skip or conflicting desktop replies: %j", async (answer) => {
    const w = world();
    w.ask.mockResolvedValue(JSON.stringify(answer));
    await w.tool.execute(local, w.context);
    expect(w.settings().mcpServers).toEqual({});
    expect(w.coordinator.reconcileGlobal).not.toHaveBeenCalled();
  });
  it("confirms global process execution, persists one entry and reports an unverified connection honestly", async () => {
    const w = world();
    const result = await w.tool.execute(local, w.context);
    expect(w.ask.mock.calls[0]?.[0]).toContain("uvx");
    expect(w.ask.mock.calls[0]?.[0]).toContain("全局");
    expect(w.settings().mcpServers?.blender).toEqual(local.config);
    expect(w.coordinator.reconcileGlobal).toHaveBeenCalledOnce();
    expect(text(result)).toContain("已保存");
    expect(text(result)).toContain("尚未验证");
    expect(text(result)).not.toContain("连接成功");
  });

  it("lists summaries without exposing env/header secrets", async () => {
    const w = world();
    await w.tool.execute({ ...local, config: { ...local.config, env: { TOKEN: "secret-value" } } }, w.context);
    const result = await w.tool.execute({ action: "list" }, w.context);
    expect(text(result)).toContain("blender");
    expect(text(result)).not.toContain("secret-value");
    expect(w.ask.mock.calls[0]?.[0]).not.toContain("secret-value");
  });

  it("never overwrites an existing name on retries", async () => {
    const w = world();
    await w.tool.execute(local, w.context);
    const result = await w.tool.execute({ ...local, config: { type: "stdio", command: "other" } }, w.context);
    expect(result.isError).toBe(true);
    expect(w.settings().mcpServers?.blender).toEqual(local.config);
    expect(w.ask).toHaveBeenCalledOnce();
  });

  it.each(["取消", "yes"])("does not save or connect without exact confirmation: %s", async (answer) => {
    const w = world();
    w.ask.mockResolvedValue(answer);
    await w.tool.execute(local, w.context);
    expect(w.settings().mcpServers).toEqual({});
    expect(w.coordinator.reconcileGlobal).not.toHaveBeenCalled();
  });

  it("rejects invalid configuration and missing interactive host before mutation", async () => {
    const w = world();
    expect((await w.tool.execute({ ...local, config: { type: "http" } }, w.context)).isError).toBe(true);
    expect((await w.tool.execute(local, { cwd: "/work", sessionId: "root" })).isError).toBe(true);
    expect(w.ask).not.toHaveBeenCalled();
    expect(w.settings().mcpServers).toEqual({});
  });

  it("blocks child sessions and plugin-scoped runs", async () => {
    const w = world();
    expect((await w.tool.execute(local, { ...w.context, sessionId: "child" })).isError).toBe(true);
    expect((await w.tool.execute(local, { ...w.context, capabilityView: { pluginId: "plugin" } as any })).isError).toBe(true);
    expect(w.settings().mcpServers).toEqual({});
    expect(w.ask).not.toHaveBeenCalled();
  });

  it("remains a normal permission-checked mutating tool, denied under plan mode", async () => {
    const w = world();
    const checker = new PermissionChecker({ mode: "plan" });
    expect((await checker.checkTool(w.tool.name, local)).action).toBe("deny");
    expect((await new PermissionChecker({ mode: "default" }).checkTool(w.tool.name, local)).action).toBe("ask");
  });

  it("does not bypass a Shell denial when configuring a local third-party process", async () => {
    const w = world();
    const settings = { ...w.settings(), permission: { mode: "full_auto" as const, deniedTools: ["Shell"] } };
    expect((await w.tool.execute(local, { ...w.context, settings })).isError).toBe(true);
    expect(w.settings().mcpServers).toEqual({});
    expect(w.ask).not.toHaveBeenCalled();
  });

  it("honors denied command patterns before asking to start a local server", async () => {
    const w = world();
    const settings = { ...w.settings(), permission: { mode: "full_auto" as const, deniedCommands: ["uvx*"] } };
    expect((await w.tool.execute(local, { ...w.context, settings })).isError).toBe(true);
    expect(w.settings().mcpServers).toEqual({});
  });

  it("adds a remote OAuth config without leaking header or query tokens", async () => {
    const w = world({ status: "error", affectedRuntimes: 1, failures: [{ runtimeId: "r", message: "auth" }] });
    const config = { type: "http", url: "https://example.test/mcp?key=secret-value", headers: { Authorization: "Bearer secret-value" }, oauth: { scopes: ["read"] } };
    const result = await w.tool.execute({ action: "add", name: "remote", config }, w.context);
    expect(w.settings().mcpServers?.remote).toEqual(config);
    expect(text(result)).toContain("授权");
    expect(text(result)).not.toContain("secret-value");
    expect(w.ask.mock.calls[0]?.[0]).not.toContain("secret-value");
  });

  it("does not persist when the run is cancelled during confirmation", async () => {
    const w = world();
    const controller = new AbortController();
    w.ask.mockImplementation(async () => { controller.abort(); return "确认添加"; });
    await w.tool.execute(local, { ...w.context, abortSignal: controller.signal });
    expect(w.settings().mcpServers).toEqual({});
    expect(w.coordinator.reconcileGlobal).not.toHaveBeenCalled();
  });

  it("keeps saved configuration when connection fails without leaking runtime errors", async () => {
    const w = world({ status: "error", affectedRuntimes: 1, failures: [{ runtimeId: "r", message: "token=secret-value" }] });
    const result = await w.tool.execute(local, w.context);
    expect(w.settings().mcpServers?.blender).toEqual(local.config);
    expect(text(result)).toContain("已保存");
    expect(text(result)).toContain("连接更新失败");
    expect(text(result)).not.toContain("secret-value");
  });

  it("reports verified runtime updates and does not promise current-turn tool visibility", async () => {
    const w = world({ status: "connected", affectedRuntimes: 1, failures: [] });
    const result = await w.tool.execute(local, w.context);
    expect(text(result)).toContain("活动会话");
    expect(text(result)).toContain("下一轮");
  });
});
