import { describe, it, expect } from "vitest";
import {
  computeReadiness,
  inferMcpTransport,
  countEffectiveTools,
  buildDryRunReport,
} from "./dry-run";
import type { Settings } from "@vykor/core";

function makeSettings(partial: Partial<Settings> = {}): Settings {
  return {
    model: "gpt-4",
    apiFormat: "openai",
    maxTurns: 10,
    permission: { mode: "default" },
    ...partial,
  };
}

describe("computeReadiness", () => {
  it("returns 'ready' when key and model are present", () => {
    expect(computeReadiness({ hasKey: true, hasModel: true })).toEqual({
      verdict: "ready",
      notes: ["API key and model are configured."],
    });
  });

  it("returns 'blocked' when no key", () => {
    const r = computeReadiness({ hasKey: false, hasModel: true });
    expect(r.verdict).toBe("blocked");
    expect(r.notes[0]).toContain("No API key");
  });

  it("blocked takes priority even when model is also missing", () => {
    expect(computeReadiness({ hasKey: false, hasModel: false }).verdict).toBe("blocked");
  });

  it("returns 'warning' when key present but model missing", () => {
    const r = computeReadiness({ hasKey: true, hasModel: false });
    expect(r.verdict).toBe("warning");
    expect(r.notes[0]).toContain("No model");
  });
});

describe("inferMcpTransport", () => {
  it("uses explicit type when given", () => {
    expect(inferMcpTransport({ type: "sse", url: "https://x" })).toBe("sse");
  });
  it("returns the declared http transport", () => {
    expect(inferMcpTransport({ type: "http", url: "https://x" })).toBe("http");
  });
  it("returns the declared stdio transport", () => {
    expect(inferMcpTransport({ type: "stdio", command: "node" })).toBe("stdio");
  });
});

describe("countEffectiveTools", () => {
  const all = ["Bash", "Read", "Write", "Edit"];
  it("counts all when no allow/deny", () => {
    expect(countEffectiveTools(all, [], [])).toBe(4);
  });
  it("restricts to allowlist when allowlist non-empty", () => {
    expect(countEffectiveTools(all, ["Bash", "Read"], [])).toBe(2);
  });
  it("removes denied tools", () => {
    expect(countEffectiveTools(all, [], ["Bash"])).toBe(3);
  });
  it("applies allow then deny", () => {
    expect(countEffectiveTools(all, ["Bash", "Read"], ["Bash"])).toBe(1);
  });
});

describe("buildDryRunReport", () => {
  const allToolNames = ["Bash", "Read", "Write"];

  it("maps settings + key check into a report", () => {
    const settings = makeSettings({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["s.js"] },
        remote: { type: "http", url: "https://mcp.example/sse" },
      },
    });
    const report = buildDryRunReport({
      settings,
      options: {},
      keyCheck: { ok: true, source: "credentials.json [deepseek]" },
      allToolNames,
      skillCount: 5,
    });

    expect(report.model).toBe("deepseek-chat");
    expect(report.provider).toBe("deepseek");
    expect(report.keySource).toBe("credentials.json [deepseek]");
    expect(report.baseURL).toBe("https://api.deepseek.com/v1");
    expect(report.apiFormat).toBe("openai");
    expect(report.permissionMode).toBe("default");
    expect(report.toolCount).toBe(3);
    expect(report.skillCount).toBe(5);
    expect(report.pluginsEnabled).toBe(true);
    expect(report.mcpServers).toEqual([
      { name: "local", transport: "stdio" },
      { name: "remote", transport: "http" },
    ]);
    expect(report.readiness.verdict).toBe("ready");
  });

  it("reports the plugin master switch", () => {
    const report = buildDryRunReport({
      settings: makeSettings({ plugins: { enabled: false } }),
      options: {},
      keyCheck: { ok: true, source: "found" },
      allToolNames,
      skillCount: 0,
    });
    expect(report.pluginsEnabled).toBe(false);
  });

  it("CLI options override settings", () => {
    const settings = makeSettings({ provider: "openai", model: "gpt-4" });
    const report = buildDryRunReport({
      settings,
      options: {
        model: "gpt-5",
        provider: "anthropic",
        permissionMode: "plan",
        baseUrl: "https://override/v1",
        apiFormat: "anthropic",
      },
      keyCheck: { ok: true, source: "env" },
      allToolNames,
      skillCount: 0,
    });
    expect(report.model).toBe("gpt-5");
    expect(report.provider).toBe("anthropic");
    expect(report.permissionMode).toBe("plan");
    expect(report.baseURL).toBe("https://override/v1");
    expect(report.apiFormat).toBe("anthropic");
  });

  it("blocked when key check fails", () => {
    const report = buildDryRunReport({
      settings: makeSettings(),
      options: {},
      keyCheck: { ok: false, source: "not set" },
      allToolNames,
      skillCount: 0,
    });
    expect(report.readiness.verdict).toBe("blocked");
  });

  it("no provider/baseUrl → (auto-detect) labels", () => {
    const settings = makeSettings({ provider: undefined, baseUrl: undefined });
    const report = buildDryRunReport({
      settings,
      options: {},
      keyCheck: { ok: true, source: "found" },
      allToolNames,
      skillCount: 0,
    });
    expect(report.provider).toBe("(auto-detect)");
    expect(report.baseURL).toBe("(auto-detect)");
  });

  it("resolves the provider's default baseURL when baseUrl is unset", () => {
    const settings = makeSettings({ provider: "deepseek", baseUrl: undefined });
    const report = buildDryRunReport({
      settings,
      options: {},
      keyCheck: { ok: true, source: "credentials.json [deepseek]" },
      allToolNames,
      skillCount: 0,
    });
    // 与 resolveApiClient 一致：未显式设 baseUrl 时取 provider 注册默认。
    expect(report.baseURL).toBe("https://api.deepseek.com/v1");
  });

  it("merges CLI allowed/disallowed tools with settings for tool count", () => {
    const settings = makeSettings({
      permission: { mode: "default", deniedTools: ["Write"] },
    });
    const report = buildDryRunReport({
      settings,
      options: { allowedTools: "Bash,Read,Write", disallowedTools: "Read" },
      keyCheck: { ok: true, source: "x" },
      allToolNames,
      skillCount: 0,
    });
    // allow {Bash,Read,Write} ∩ all → {Bash,Read,Write}; deny {Write,Read} → {Bash}
    expect(report.toolCount).toBe(1);
  });
});
