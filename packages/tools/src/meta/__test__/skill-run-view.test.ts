import { expect, it } from "vitest";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import type { RunCapabilityView } from "@openharness/core";
import { skillTool, listSkillsTool } from "../skill.js";

const definition: SkillDefinition = { name: "private", source: "plugin", path: "/plugin/private/SKILL.md",
  description: "private summary", content: "private body", userInvocable: true, disableModelInvocation: false };
const view = (pluginId?: string, ownerPluginId?: string): RunCapabilityView => ({
  pluginId, skills: new Map(ownerPluginId ? [["private", { ownerPluginId, definition, path: definition.path }]] : []),
  tools: new Map(), agents: new Map(), mcpServers: new Map(),
});

it("blocks loading and discovering a plugin Skill outside the current View", async () => {
  const registry = new SkillRegistry();
  registry.register(definition);
  for (const capabilityView of [view(), view("other"), view("other", "owner")]) {
    const context = { cwd: process.cwd(), skillRegistry: registry, capabilityView };
    expect((await skillTool.execute({ name: "private", path: definition.path }, context)).isError).toBe(true);
    expect(JSON.stringify(await listSkillsTool.execute({ visibility: "all" }, context))).not.toContain("private summary");
  }
});

it("loads the captured Skill after registry replacement and checks its name/path winner", async () => {
  const registry = new SkillRegistry();
  registry.register({ ...definition, content: "replacement body", path: "/replacement/SKILL.md" });
  const context = { cwd: process.cwd(), skillRegistry: registry, capabilityView: view("owner", "owner") };
  const result = await skillTool.execute({ name: "private", path: definition.path }, context);
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain("private body");
  expect(JSON.stringify(result)).not.toContain("replacement body");
  expect((await skillTool.execute({ name: "foreign", path: definition.path }, context)).isError).toBe(true);
  expect((await skillTool.execute({ name: "private", path: "/replacement/SKILL.md" }, context)).isError).toBe(true);
});
