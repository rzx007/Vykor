import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultToolRegistry } from "../registry.js";
import { SkillRegistry } from "@vykor/skills";

describe("createDefaultToolRegistry", () => {
  it("registers all built-in tools", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.getAll();
    const names = tools.map((t) => t.name);
    expect(names).toContain("Shell");
    expect(names).not.toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
    expect(names).toContain("WebFetch");
    expect(names).toContain("WebSearch");
    expect(names).toContain("TodoWrite");
    expect(names).toContain("Config");
    expect(names).toContain("Sleep");
    expect(names).toContain("Skill");
    expect(names).toContain("ListSkills");
    expect(names).toContain("ToolSearch");
    expect(names).toContain("AskUser");
    expect(names).toContain("Brief");
    expect(names).toContain("BackgroundShellCreate");
    expect(names).not.toContain("TaskCreate");
    expect(names).toContain("EnterPlanMode");
    expect(names).toContain("ExitPlanMode");
    expect(names).toContain("EnterWorktree");
    expect(names).toContain("ExitWorktree");
    expect(names).toContain("NotebookEdit");
    expect(names).toContain("Agent");
    expect(names).not.toContain("Workflow");
    expect(names).toContain("TeamCreate");
    expect(names).toContain("TeamDelete");
    expect(names).toContain("McpToolCall");
    expect(names).toContain("ListMcpResources");
    expect(names).toContain("ReadMcpResource");
    expect(names).toContain("McpAuth");
    expect(names).toContain("Lsp");
    expect(names).not.toContain("ImageToText");
    expect(names).not.toContain("ImageGeneration");
    expect(names).toContain("FeishuPush");
    expect(tools).toHaveLength(31);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "TaskGet",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "TaskUpdate",
        "TaskWait",
        "SendMessage",
      ]),
    );
  });

  it("registers Workflow only when durable storage is explicit", () => {
    const repository = { repositoryKey: "test", list: () => [] } as any;
    const names = createDefaultToolRegistry({ workflowRepository: repository })
      .getAll()
      .map((tool) => tool.name);
    expect(names).toContain("Workflow");
  });

  it("registers Agent Scheduled tools as the only scheduling capability", () => {
    const names = createDefaultToolRegistry({ schedules: true })
      .getAll()
      .map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "ScheduleCreate",
        "ScheduleUpdate",
        "ScheduleDelete",
        "ScheduleList",
        "ScheduleRunNow",
      ]),
    );
    expect(names.filter((name) => name.startsWith("Cron"))).toEqual([]);
  });

  it("registers terminal creation separately from common job controls", () => {
    const defaultNames = createDefaultToolRegistry()
      .getAll()
      .map((tool) => tool.name);
    const terminalNames = createDefaultToolRegistry({
      terminal: true,
      jobs: true,
    })
      .getAll()
      .map((tool) => tool.name);
    expect(defaultNames).not.toContain("TerminalOpen");
    expect(terminalNames).toEqual(
      expect.arrayContaining([
        "TerminalOpen",
        "JobSend",
        "JobRead",
        "JobWait",
        "JobCancel",
        "JobList",
      ]),
    );
    expect(terminalNames).not.toEqual(
      expect.arrayContaining(["TerminalRead", "TerminalClose"]),
    );
  });

  it("each tool has required fields", () => {
    const registry = createDefaultToolRegistry();
    for (const tool of registry.getAll()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("can retrieve individual tools", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.get("Shell")).toBeDefined();
    expect(registry.get("Bash")).toBeUndefined();
    expect(registry.get("Read")).toBeDefined();
    expect(registry.get("Write")).toBeDefined();
    expect(registry.get("Edit")).toBeDefined();
    expect(registry.get("Glob")).toBeDefined();
    expect(registry.get("Grep")).toBeDefined();
    expect(registry.get("WebFetch")).toBeDefined();
    expect(registry.get("WebSearch")).toBeDefined();
    expect(registry.get("NonExistent")).toBeUndefined();
  });

  it("returns a skill with its trusted file and resource root", async () => {
    const skills = new SkillRegistry();
    const skillRoot = join(tmpdir(), "location-fixture");
    const skillFile = join(skillRoot, "SKILL.md");
    skills.register({
      name: "location-fixture",
      description: "fixture",
      content: "# Location fixture\n\nRead references/guide.md.",
      path: skillFile,
      source: "plugin",
      userInvocable: true,
      disableModelInvocation: false,
    });
    const tool = createDefaultToolRegistry().get("Skill")!;

    const result = await tool.execute(
      { name: "location-fixture" },
      { cwd: dirname(skillRoot), skillRegistry: skills } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: [
        "Skill: location-fixture",
        `Skill file: ${skillFile}`,
        `Skill root: ${skillRoot}`,
        "",
        "Resolve relative paths mentioned by this skill against Skill root.",
        "",
        "<skill-content>",
        "# Location fixture",
        "",
        "Read references/guide.md.",
        "</skill-content>",
      ].join("\n"),
    });
  });

  it("has() works for registered tools", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.has("Shell")).toBe(true);
    expect(registry.has("Bash")).toBe(false);
    expect(registry.has("nope")).toBe(false);
  });
});
