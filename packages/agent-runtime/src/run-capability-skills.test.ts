import { expect, it } from "vitest";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import type { AgentExecutionContext } from "@openharness/core";
import { createOpenHarnessRuntime } from "./default-runtime.js";
import { installRuntimeIntegrations } from "./runtime-integrations.js";

it("keeps baseline Skills and selects only the current Run's plugin summaries", async () => {
  const skillRegistry = new SkillRegistry();
  const skill = (name: string, source: SkillDefinition["source"], description: string): SkillDefinition => ({
    name, source, description, path: `/${source}/${name}/SKILL.md`, content: `PRIVATE BODY ${description}`,
    userInvocable: true, disableModelInvocation: false,
  });
  skillRegistry.register(skill("overlap", "bundled", "baseline-summary"));
  skillRegistry.register(skill("overlap", "plugin", "plugin-summary"));
  skillRegistry.register(skill("foreign", "plugin", "foreign-summary"));
  const prompts: string[] = [];
  const toolNames: string[][] = [];
  const userInputs: string[] = [];
  const runtime = await createOpenHarnessRuntime({
    cwd: process.cwd(), settings: { model: "test", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" } }, skillRegistry,
    configuration: { client: { async *streamMessage(input) {
      prompts.push(input.system ?? "");
      toolNames.push(input.tools?.map((tool) => tool.name) ?? []);
      userInputs.push(JSON.stringify(input.messages));
      yield { type: "complete" as const, stopReason: "end_turn" };
    } } },
  });
  try {
    runtime.toolRegistry.register({ name: "PrivateNative", description: "private tool", inputSchema: {
      type: "object", properties: { schemaOnlyField: { type: "string" } },
    }, execute: async () => ({ content: [] }) }, { kind: "plugin", id: "one" });
    await installRuntimeIntegrations({ cwd: process.cwd(), sessionId: "test", settings: runtime.settings, runtime,
      discovery: { skillRegistry, plugins: [], agentDefinitions: [], warnings: [], mcpServers: {},
        pluginCapabilityInventory: {
          plugins: new Map(["one", "two"].map((pluginId) => [pluginId, {
            pluginId, displayName: pluginId, description: "", version: "1.0.0", scope: "user", origin: "native",
            skillNames: [], agentNames: [], mcpServerIds: [], nativeToolEntries: [],
          }])),
          skills: new Map([["overlap", { pluginId: "one", path: "/plugin/overlap/SKILL.md" }], ["foreign", { pluginId: "two", path: "/plugin/foreign/SKILL.md" }]]),
          agents: new Map(), mcpServers: new Map(), nativeToolEntries: new Map(), diagnostics: [],
        },
      },
    });
    expect(runtime.queryEngine.getContextUsagePromptSource().systemPrompt).toContain("baseline-summary");
    expect(runtime.queryEngine.getContextUsagePromptSource().systemPrompt).not.toContain("plugin-summary");
    for (const pluginId of [undefined, "one", undefined]) {
      const capabilityView = runtime.createRunCapabilityView!(pluginId);
      const execution = { capabilityView, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {} } as unknown as AgentExecutionContext;
      for await (const _ of runtime.queryEngine.submitMessage("go", { execution })) {}
    }
    expect(prompts[0]).toContain("baseline-summary");
    expect(prompts[0]).not.toContain("plugin-summary");
    expect(prompts[1]).toContain("plugin-summary");
    expect(prompts[1]).not.toContain("baseline-summary");
    expect(prompts[2]).toContain("baseline-summary");
    expect(prompts.join("\n")).not.toContain("foreign-summary");
    expect(prompts.join("\n")).not.toContain("PRIVATE BODY");
    expect(toolNames[0]).not.toContain("PrivateNative");
    expect(toolNames[1]).toContain("PrivateNative");
    expect(toolNames[2]).not.toContain("PrivateNative");
    expect(userInputs.join("\n")).not.toContain("schemaOnlyField");
    expect(prompts.join("\n")).not.toContain("schemaOnlyField");
  } finally { await runtime.close(); }
});
