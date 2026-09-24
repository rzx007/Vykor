import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentFrontmatter, loadAgentsDir, mergeAgentDefinitions } from "../agent-loader.js";
import type { AgentDefinition } from "../index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vk-agents-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseAgentFrontmatter", () => {
  it("parses nested YAML structures (hooks dict, mcpServers list)", () => {
    const { frontmatter, body } = parseAgentFrontmatter(
      [
        "---",
        "name: reviewer",
        "description: Reviews code",
        "tools: [Read, Grep]",
        "hooks:",
        "  pre_tool_use:",
        "    - type: command",
        "      command: echo hi",
        "mcpServers:",
        "  - db-server",
        "---",
        "You are a reviewer.",
      ].join("\n"),
    );
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.tools).toEqual(["Read", "Grep"]);
    expect((frontmatter.hooks as Record<string, unknown[]>).pre_tool_use).toHaveLength(1);
    expect(frontmatter.mcpServers).toEqual(["db-server"]);
    expect(body).toBe("You are a reviewer.");
  });

  it("rejects invalid YAML instead of guessing a line-based format", () => {
    expect(() => parseAgentFrontmatter(
      ["---", "name: broken", "desc: [unclosed", "---", "Body"].join("\n"),
    )).toThrow();
  });

  it("returns empty frontmatter without the --- header", () => {
    const { frontmatter, body } = parseAgentFrontmatter("Just a body.");
    expect(frontmatter).toEqual({});
    expect(body).toBe("Just a body.");
  });
});

describe("loadAgentsDir", () => {
  function writeAgent(name: string, content: string): void {
    writeFileSync(join(tmp, `${name}.md`), content);
  }

  it("loads the current camelCase field set", () => {
    writeAgent(
      "full",
      [
        "---",
        "name: full-agent",
        "description: Does everything",
        "tools: Read, Grep",
        "disallowedTools: [Write]",
        "model: inherit",
        "effort: high",
        "permissionMode: plan",
        "maxTurns: 7",
        "skills: commit, review",
        "color: red",
        "background: true",
        "initialPrompt: start here",
        "memory: project",
        "isolation: worktree",
        "omitClaudeMd: true",
        "criticalSystemReminder: stay safe",
        "requiredMcpServers: [db]",
        "permissions: 'a,b'",
        "---",
        "System prompt body.",
      ].join("\n"),
    );
    const [agent] = loadAgentsDir(tmp);
    expect(agent!.name).toBe("full-agent");
    expect(agent!.systemPrompt).toBe("System prompt body.");
    expect(agent!.tools).toEqual(["Read", "Grep"]);
    expect(agent!.disallowedTools).toEqual(["Write"]);
    expect(agent!.model).toBe("inherit");
    expect(agent!.effort).toBe("high");
    expect(agent!.permissionMode).toBe("plan");
    expect(agent!.maxTurns).toBe(7);
    expect(agent!.skills).toEqual(["commit", "review"]);
    expect(agent!.color).toBe("red");
    expect(agent!.background).toBe(true);
    expect(agent!.initialPrompt).toBe("start here");
    expect(agent!.memory).toBe("project");
    expect(agent!.isolation).toBe("worktree");
    expect(agent!.omitClaudeMd).toBe(true);
    expect(agent!.criticalSystemReminder).toBe("stay safe");
    expect(agent!.requiredMcpServers).toEqual(["db"]);
    expect(agent!.permissions).toEqual(["a", "b"]);
    expect(agent!.filename).toBe("full");
    expect(agent!.baseDir).toBe(tmp);
    expect(agent!.source).toBe("user");
    expect(agent!.subagentType).toBe("full-agent");
  });

  it("defaults name to filename and description to Agent: <name>", () => {
    writeAgent("bare", "Just a prompt.");
    const [agent] = loadAgentsDir(tmp);
    expect(agent!.name).toBe("bare");
    expect(agent!.description).toBe("Agent: bare");
    expect(agent!.systemPrompt).toBe("Just a prompt.");
  });

  it("silently drops invalid enum values (color/memory/permissionMode)", () => {
    writeAgent(
      "weird",
      ["---", "name: weird", "color: rainbow", "memory: galaxy", "permissionMode: yolo", "maxTurns: -3", "---", "x"].join("\n"),
    );
    const [agent] = loadAgentsDir(tmp);
    expect(agent!.color).toBeUndefined();
    expect(agent!.memory).toBeUndefined();
    expect(agent!.permissionMode).toBeUndefined();
    expect(agent!.maxTurns).toBeUndefined();
  });

  it("accepts free-form effort strings and positive integers, dropping empties", () => {
    writeAgent("effort-str", ["---", "name: e1", "effort: xhigh", "---", "x"].join("\n"));
    writeAgent("effort-num", ["---", "name: e2", "effort: 3", "---", "x"].join("\n"));
    writeAgent("effort-empty", ["---", "name: e3", 'effort: ""', "---", "x"].join("\n"));
    const byName = Object.fromEntries(loadAgentsDir(tmp).map((a) => [a.name, a]));
    expect(byName.e1!.effort).toBe("xhigh");
    expect(byName.e2!.effort).toBe(3);
    expect(byName.e3!.effort).toBeUndefined();
  });

  it("skips unreadable files and missing dirs without crashing", () => {
    writeAgent("good", "ok");
    rmSync(join(tmp, "good.md")); // 留空目录
    expect(loadAgentsDir(tmp)).toEqual([]);
    expect(loadAgentsDir(join(tmp, "nope"))).toEqual([]);
  });
});

describe("mergeAgentDefinitions", () => {
  const make = (name: string, source: AgentDefinition["source"]): AgentDefinition => ({
    name,
    description: `${name} from ${source}`,
    source,
  });

  it("merges builtin < user < plugin with last-writer-wins by name", () => {
    const merged = mergeAgentDefinitions(
      [make("Explore", "builtin"), make("worker", "builtin")],
      [make("Explore", "user"), make("custom", "user")],
      [make("custom", "plugin")],
    );
    const byName = Object.fromEntries(merged.map((a) => [a.name, a.source]));
    expect(byName).toEqual({ Explore: "user", worker: "builtin", custom: "plugin" });
  });
});
