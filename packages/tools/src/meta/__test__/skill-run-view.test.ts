import { expect, it } from "vitest";
import type { ToolSkillDefinition as SkillDefinition } from "../../ports/skill.js";
import type { RunCapabilityView, ToolContext } from "@vykor/core";
import { createSkillTools, capturedSkillCatalog } from "../skill.js";
const skills = createSkillTools(capturedSkillCatalog);
const skillTool = skills.find(tool => tool.name === "Skill")!;
const listSkillsTool = skills.find(tool => tool.name === "ListSkills")!;

const definition: SkillDefinition = { name: "private", source: "plugin", path: "/plugin/private/SKILL.md",
  description: "private summary", content: "private body", userInvocable: true, disableModelInvocation: false };
const view = (pluginId?: string, ownerPluginId?: string): RunCapabilityView => ({
  pluginId, skills: new Map(ownerPluginId ? [["private", { ownerPluginId, definition, path: definition.path }]] : []),
  tools: new Map(), agents: new Map(), mcpServers: new Map(),
});

it("blocks loading and discovering a plugin Skill outside the current View", async () => {
  const registry = { getAll: () => [definition] };
  for (const capabilityView of [view(), view("other"), view("other", "owner")]) {
    const context = { cwd: process.cwd(), skillRegistry: registry, capabilityView };
    expect((await skillTool.execute({ name: "private", path: definition.path }, context)).isError).toBe(true);
    expect(JSON.stringify(await listSkillsTool.execute({ visibility: "all" }, context))).not.toContain("private summary");
  }
});

it("loads the captured Skill after registry replacement and checks its name/path winner", async () => {
  const registry = { getAll: () => [{ ...definition, content: "replacement body", path: "/replacement/SKILL.md" }] };
  const context = { cwd: process.cwd(), skillRegistry: registry, capabilityView: view("owner", "owner") };
  const result = await skillTool.execute({ name: "private", path: definition.path }, context);
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain("private body");
  expect(JSON.stringify(result)).not.toContain("replacement body");
  expect((await skillTool.execute({ name: "foreign", path: definition.path }, context)).isError).toBe(true);
  expect((await skillTool.execute({ name: "private", path: "/replacement/SKILL.md" }, context)).isError).toBe(true);
});

it("loads each authorized owner in a multi-plugin view and rejects forged owner or path bindings", async () => {
  const first = { ownerPluginId: "first", definition, path: definition.path };
  const secondDefinition = { ...definition, name: "second", path: "/second/SKILL.md", content: "second body" };
  const capabilityView: RunCapabilityView = { ...view(), pluginIds: new Set(["first", "second"]), skills: new Map([
    ["private", first], ["second", { ownerPluginId: "second", definition: secondDefinition, path: secondDefinition.path }],
  ]) };
  for (const name of ["private", "second"]) expect((await skillTool.execute({ name }, { cwd: process.cwd(), capabilityView })).isError).not.toBe(true);
  for (const forged of [{ ...first, ownerPluginId: "foreign" }, { ...first, path: "/forged/SKILL.md" }]) {
    const result = await skillTool.execute({ name: "private" }, { cwd: process.cwd(), capabilityView: { ...capabilityView, skills: new Map([["private", forged]]) } });
    expect(result.isError).toBe(true);
  }
});

it("loads a captured Skill using the environment path returned by ListSkills without widening its source", async () => {
  const hostPath = "C:/approved/private/SKILL.md";
  const executionPath = "/mnt/c/approved/private/SKILL.md";
  const captured = { ...definition, path: hostPath };
  const capabilityView = { ...view("owner", "owner"), skills: new Map([
    [captured.name, { ownerPluginId: "owner", definition: captured, path: hostPath }],
  ]) };
  const context = { cwd: "/mnt/d/workspace", capabilityView, environment: { paths: {
    presentHostPath: (path: string) => path.replace("C:/", "/mnt/c/"),
    toHostPath: (path: string) => path.startsWith("/mnt/c/") ? path.replace("/mnt/c/", "C:/") : undefined,
  } } } as ToolContext;
  const listing = JSON.stringify(await listSkillsTool.execute({}, context));
  expect(listing).toContain(executionPath);
  const loaded = await skillTool.execute({ name: captured.name, path: executionPath }, context);
  expect(loaded.isError).not.toBe(true);
  expect(JSON.stringify(loaded)).toContain("private body");
  expect((await skillTool.execute({ name: "foreign", path: executionPath }, context)).isError).toBe(true);
  expect((await skillTool.execute({ name: captured.name, path: "/mnt/c/foreign/SKILL.md" }, context)).isError).toBe(true);
  expect((await skillTool.execute({ name: captured.name, path: executionPath }, {
    ...context, capabilityView: { ...capabilityView, pluginId: "other" },
  })).isError).toBe(true);
});

it("resolves a qualified plugin Skill only inside its captured capability view", async () => {
 const plugin = {...definition, commandName:"office-work:private"};
 const capabilityView = view("owner", "owner");
 const binding = capabilityView.skills.get("private")!;
 const own = {...capabilityView, skills:new Map([["private", {...binding, definition:plugin}]])};
 const result = await skillTool.execute({name:"office-work:private",path:plugin.path},{cwd:process.cwd(),capabilityView:own});
 expect(result.isError).not.toBe(true);
 expect(JSON.stringify(result)).toContain("private body");
 const foreign={...own,pluginId:"other"};
 expect((await skillTool.execute({name:"office-work:private"},{cwd:process.cwd(),capabilityView:foreign})).isError).toBe(true);
});
