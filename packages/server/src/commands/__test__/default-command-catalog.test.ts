import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Settings } from "@vykor/core";
import {
  getAgentDefinition,
  registerPluginAgents,
} from "@vykor/coordinator";
import { discoverVykorExtensions } from "@vykor/agent-runtime";

import { createDefaultCommandCatalog } from "../default-command-catalog.js";

function minimalSettings(): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 32,
    permission: { mode: "default" },
  };
}

describe("createDefaultCommandCatalog", () => {
  it("lists bundled user-invocable skills as template commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-catalog-"));
    try {
      const catalog = createDefaultCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.map((command) => command.name)).toEqual(
        expect.arrayContaining(["/commit", "/review", "/plan"]),
      );
      expect(commands.every((command) => command.kind === "template")).toBe(true);
      expect(commands.find((command) => command.name === "/commit")?.source).toBe(
        "bundled",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes project skills from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-catalog-project-"));
    try {
      const skillDir = join(dir, ".vykor", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "ship.md"),
        "---\nname: ship\ndescription: Ship it\nuser-invocable: true\n---\nShip the change.\n",
      );
      const catalog = createDefaultCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.find((command) => command.name === "/ship")).toMatchObject({
        kind: "template",
        source: "project",
        description: "Ship it",
        path: join(skillDir, "ship.md"),
        skillName: "ship",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads commands for cwd B without replacing the agent definitions already active for cwd A", async () => {
    const root = mkdtempSync(join(tmpdir(), "vk-catalog-scoped-agents-"));
    const cwdA = join(root, "workspace-a");
    const cwdB = join(root, "workspace-b");
    const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = join(root, "config");

    function writePlugin(cwd: string, suffix: string, model: string, command: string): void {
      const pluginDir = join(root, "cache", suffix);
      mkdirSync(join(pluginDir, ".vykor-plugin"), { recursive: true });
      mkdirSync(join(pluginDir, "agents"), { recursive: true });
      mkdirSync(join(pluginDir, "skills", command), { recursive: true });
      writeFileSync(
        join(pluginDir, ".vykor-plugin", "plugin.json"),
        JSON.stringify({ schemaVersion: 1, id: `dev.vykor.${suffix}`, name: "scoped", version: "1.0.0", components: { agents: ["./agents"], skills: ["./skills"] } }),
      );
      writeFileSync(
        join(pluginDir, "agents", "reviewer.md"),
        `---\nmodel: ${model}\n---\nReview this workspace.\n`,
      );
      writeFileSync(
        join(pluginDir, "skills", command, "SKILL.md"),
        `---\nname: ${command}\ndescription: ${command} command\n---\nRun ${command}.\n`,
      );
      const storePath = join(root, "config", "plugins", "installed.json");
      mkdirSync(join(storePath, ".."), { recursive: true });
      let store: { schemaVersion: 1; revision: number; plugins: Record<string, unknown> } = { schemaVersion: 1, revision: 0, plugins: {} };
      try { store = JSON.parse(readFileSync(storePath, "utf8")); } catch {}
      store.plugins[`user::dev.vykor.${suffix}`] = { id: `dev.vykor.${suffix}`, scope: "user", enabled: true, currentVersion: "1.0.0", cachePath: pluginDir, linkedSourcePath: pluginDir, origin: "native", requestedPermissions: [], approvedPermissions: [], installedAt: "now", updatedAt: "now" };
      writeFileSync(storePath, JSON.stringify(store));
    }

    const settings: Settings = minimalSettings();

    try {
      writePlugin(cwdA, "plugin-a", "model-a", "command-a");
      writePlugin(cwdB, "plugin-b", "model-b", "command-b");
      const discoveryA = await discoverVykorExtensions(cwdA, settings);
      registerPluginAgents(discoveryA.agentDefinitions);

      const commands = await createDefaultCommandCatalog(settings).list({
        cwd: cwdB,
      });

      expect(commands.map((command) => command.name)).toContain(
        "/scoped:command-b",
      );
      expect(getAgentDefinition("dev.vykor.plugin-a:reviewer")?.model).toBe("model-a");
    } finally {
      registerPluginAgents([]);
      if (previousConfigDir === undefined) {
        delete process.env.VYKOR_CONFIG_DIR;
      } else {
        process.env.VYKOR_CONFIG_DIR = previousConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
