import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { PluginInfo } from "@vykor/client";

const clientMocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../ensure-daemon.js", () => ({
  ensureLocalDaemon: vi.fn(async () => ({ url: "http://127.0.0.1:4000", token: "test-token" })),
}));
vi.mock("@vykor/client", () => ({
  VykorClient: class {
    plugins = { list: clientMocks.list };
  },
}));

import { createPluginCommand, formatPluginList } from "./plugin";

function plugin(partial: Partial<PluginInfo> = {}): PluginInfo {
  return {
    identity: {
      id: "context7",
      name: "context7",
      displayName: "Context7",
      version: "1.2.3",
    },
    origin: "converted",
    sourceFormat: "claude-code",
    scope: "user",
    enabled: true,
    installation: "installed",
    activation: "active",
    toolRuntime: {
      state: "active",
      declaredEntries: 2,
      activatableEntries: 2,
      hostCount: 1,
      registeredToolCount: 2,
    },
    inventory: { commands: 1, tools: 2 },
    permissions: { requested: ["network"], approved: ["network"], missing: [] },
    diagnostics: [],
    ...partial,
  };
}

describe("formatPluginList", () => {
  it("formats an aligned human-readable summary", () => {
    const output = formatPluginList({ plugins: [plugin()], warnings: [] });
    expect(output).toContain("PLUGIN");
    expect(output).toContain("Context7  1.2.3");
    expect(output).toContain("user   enabled  active");
    expect(output).toContain("2/2");
  });

  it("includes runtime, permissions, diagnostics, and warnings in verbose mode", () => {
    const output = formatPluginList(
      {
        plugins: [
          plugin({
            permissions: {
              requested: ["network", "process"],
              approved: ["network"],
              missing: ["process"],
            },
            diagnostics: [
              {
                severity: "warning",
                phase: "activate",
                code: "PLUGIN_PARTIAL",
                message: "One entry failed",
              },
            ],
          }),
        ],
        warnings: ["Cache was rebuilt"],
      },
      true,
    );
    expect(output).toContain("origin       converted (claude-code)");
    expect(output).toContain("tool runtime active; hosts=1; registered=2");
    expect(output).toContain("missing       process");
    expect(output).toContain("PLUGIN_PARTIAL: One entry failed");
    expect(output).toContain("warning: Cache was rebuilt");
  });

  it("uses a clear empty state", () => {
    expect(formatPluginList({ plugins: [], warnings: [] })).toBe(
      "No Native Plugins installed.",
    );
  });

  it("keeps columns aligned for wide CJK plugin names", () => {
    const output = formatPluginList({
      plugins: [plugin({ identity: { id: "docs", name: "docs", displayName: "文档助手", version: "1.0.0" } })],
      warnings: [],
    });
    expect(output).toContain("文档助手  1.0.0");
  });
});

describe("createPluginCommand", () => {
  it("routes list through the plugins resource and preserves JSON output", async () => {
    const result = { plugins: [plugin()], warnings: [] };
    clientMocks.list.mockResolvedValueOnce(result);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createPluginCommand().parseAsync(["list", "--cwd", ".", "--json"], { from: "user" });
      expect(clientMocks.list).toHaveBeenCalledWith({ cwd: process.cwd() });
      expect(log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    } finally {
      log.mockRestore();
    }
  });
  it("previews Codex conversion with permission and loss approvals in JSON", async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
    try {
      const source = fileURLToPath(new URL("../../../../packages/plugin-converters/fixtures/codex/mixed-plugin", import.meta.url));
      await createPluginCommand().parseAsync(["convert", source, "--from", "codex", "--dry-run", "--json"], { from: "user" });
      const result = JSON.parse(output.join("\n"));
      expect(result.detection.converterId).toBe("codex");
      expect(result.plan.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceKind: "apps", fidelity: "unsupported", requiredApprovals: ["apps:.app.json"] }),
        expect.objectContaining({ sourceKind: "mcpServers", requiredApprovals: ["mcpServers:.mcp.json#docs", "network:https://docs.example.invalid"] }),
      ]));
    } finally { log.mockRestore(); }
  });

  it("includes reasons and exact approval arguments in the text conversion preview", async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
    try {
      const source = fileURLToPath(new URL("../../../../packages/plugin-converters/fixtures/codex/mixed-plugin", import.meta.url));
      await createPluginCommand().parseAsync(["convert", source, "--from", "codex", "--dry-run"], { from: "user" });
      expect(output.join("\n")).toContain("no supported Native conversion");
      expect(output.join("\n")).toContain('--approve "network:https://docs.example.invalid"');
      expect(output.join("\n")).toContain('--approve "apps:.app.json"');
    } finally { log.mockRestore(); }
  });

  it("registers list output options", () => {
    const list = createPluginCommand().commands.find(
      (command) => command.name() === "list",
    );
    expect(list?.options.map((option) => option.long)).toEqual([
      "--cwd",
      "--verbose",
      "--json",
    ]);
  });

  it.each(["install-local", "link", "install"])("keeps %s user-scoped without a scope selector", (name) => {
    const command = createPluginCommand().commands.find((candidate) => candidate.name() === name);

    expect(command?.options.map((option) => option.long)).not.toContain("--scope");
  });
});
