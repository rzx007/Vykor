import { expect, it } from "vitest";
import type { RunCapabilityView, ToolContext } from "@vykor/core";
import { createSkillTools, capturedSkillCatalog } from "../skill.js";
const listSkillsTool = createSkillTools(capturedSkillCatalog).find(tool => tool.name === "ListSkills")!;

function context(count = 3): ToolContext {
  const skills = Array.from({ length: count }, (_, index) => {
    const name = `skill-${index}`;
    const path = `/plugins/${name}/SKILL.md`;
    return [name, { ownerPluginId: index % 2 ? "beta.pkg" : "alpha.pkg", path, definition: {
      name, path, description: `Summary ${index}`, content: "DO NOT LIST THIS BODY", source: "plugin", userInvocable: true, disableModelInvocation: false,
      metadata: { pluginId: "forged-metadata" },
    } }] as const;
  });
  return { cwd: "/repo", capabilityView: {
    pluginIds: new Set(["alpha.pkg", "beta.pkg"]), skills: new Map(skills), tools: new Map(), agents: new Map(), mcpServers: new Map(),
  } as RunCapabilityView };
}
const text = (result: Awaited<ReturnType<typeof listSkillsTool.execute>>) => (result.content[0] as { text: string }).text;

it("filters by authoritative plugin owner before paginating and gives exact Skill paths", async () => {
  const result = text(await listSkillsTool.execute({ ownerPluginId: "alpha.pkg", offset: 1, limit: 1 }, context(5)));
  expect(result).toContain("skill-2 — Summary 2");
  expect(result).toContain('ownerPluginId="alpha.pkg"');
  expect(result).toContain('path="/plugins/skill-2/SKILL.md"');
  expect(result).toContain("Showing 2-2 of 3");
  expect(result).toContain('"offset":2');
  expect(result).not.toContain("Summary 1");
  expect(result).not.toContain("Summary 0");
  expect(result).not.toContain("forged-metadata");
  expect(result).not.toContain("DO NOT LIST THIS BODY");
});

it("accepts pluginId as a filter alias and never falls back to the whole catalog for an unknown owner", async () => {
  expect(text(await listSkillsTool.execute({ pluginId: "beta.pkg" }, context()))).toContain("skill-1 — Summary 1");
  const missing = text(await listSkillsTool.execute({ ownerPluginId: "missing" }, context()));
  expect(missing).toContain("No model skills available");
  expect(missing).not.toContain("Summary");
});

it("caps pages, reports next offsets, and explains exhausted pages", async () => {
  const defaultPage = text(await listSkillsTool.execute({}, context(125)));
  expect(defaultPage).toContain("Showing 1-50 of 125");
  expect(defaultPage).toContain('"offset":50');
  const first = text(await listSkillsTool.execute({ limit: 1000 }, context(125)));
  expect(first).toContain("Showing 1-100 of 125");
  expect(first).toContain('"offset":100');
  expect(first).not.toContain("skill-99 —");
  const exhausted = text(await listSkillsTool.execute({ offset: 125 }, context(125)));
  expect(exhausted).toContain("offset=125, total=125");
});

it("rejects invalid pagination rather than silently replacing it with a different scope", async () => {
  for (const input of [{ offset: -1 }, { limit: 0 }, { ownerPluginId: null }, { ownerPluginId: "alpha.pkg", pluginId: "beta.pkg" }]) {
    expect((await listSkillsTool.execute(input, context())).isError).toBe(true);
  }
});
