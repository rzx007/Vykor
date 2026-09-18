import { describe, expect, it, vi } from "vitest";
import type { McpOAuthCredentialRecord, Settings } from "@openharness/core";
import { McpOAuthRuntime, type McpOAuthCredentialStore } from "@openharness/mcp";
import { createMcpCommand, type McpCommandDeps } from "./mcp.js";

function fixture() {
  let settings = {
    model: "test",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    mcpServers: {},
  } as Settings;
  const credentials = new Map<string, McpOAuthCredentialRecord>();
  const store: McpOAuthCredentialStore = {
    get: async name => credentials.get(name),
    set: async (name, value) => { credentials.set(name, value); },
    delete: async name => credentials.delete(name),
    update: async (name, mutate) => {
      const next = mutate(credentials.get(name));
      if (next) credentials.set(name, next); else credentials.delete(name);
      return next;
    },
    runExclusive: async (name, operation) => {
      const result = await operation(credentials.get(name));
      if (result.next) credentials.set(name, result.next); else credentials.delete(name);
      return result.result;
    },
  };
  const output: string[] = [];
  const login = vi.fn(async () => ({ status: "valid" as const, scopes: ["read"], verified: true }));
  const deps: McpCommandDeps = {
    loadSettings: async () => settings,
    saveSettings: async next => { settings = next; },
    store: store as any,
    runtime: new McpOAuthRuntime({ store }),
    login: login as any,
    revoke: vi.fn(async ({ serverName }) => { await store.delete(serverName); }) as any,
    openBrowser: vi.fn(async () => undefined),
    readLine: vi.fn(async () => ""),
    stdout: line => output.push(line),
  };
  const run = (...args: string[]) => createMcpCommand(deps).parseAsync(["node", "ohs", ...args]);
  return { deps, run, login, output, getSettings: () => settings };
}

describe("mcp command", () => {
  it("adds HTTP and stdio servers using Codex-compatible shapes", async () => {
    const test = fixture();
    await test.run("add", "linear", "--url", "https://mcp.linear.app/mcp");
    await test.run("add", "local", "--", "node", "server.js");
    expect(test.getSettings().mcpServers).toMatchObject({
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      local: { type: "stdio", command: "node", args: ["server.js"] },
    });
  });

  it("passes explicit scopes and no-browser to login", async () => {
    const test = fixture();
    await test.run("add", "linear", "--url", "https://mcp.linear.app/mcp");
    await test.run("login", "linear", "--scopes", "read,issues:read", "--no-browser");
    expect(test.login).toHaveBeenCalledWith(expect.objectContaining({
      scopes: ["read", "issues:read"],
      noBrowser: true,
    }), expect.any(Object));
  });

  it("returns stable JSON without credential material", async () => {
    const test = fixture();
    await test.run("add", "linear", "--url", "https://mcp.linear.app/mcp");
    await test.run("get", "linear", "--json");
    const value = test.output.at(-1)!;
    expect(value).not.toContain("accessToken");
    expect(JSON.parse(value)).toMatchObject({ name: "linear", transport: "http", authStatus: "not-logged-in" });
  });
});
