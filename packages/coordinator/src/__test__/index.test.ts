import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import {
  Coordinator,
  TeamRegistry,
  getTeamRegistry,
  getBuiltinAgentDefinitions,
  getAgentDefinition,
  hasRequiredMcpServers,
  isCoordinatorMode,
  COORDINATOR_SYSTEM_PROMPT,
} from "../index.js";

// getAllAgentDefinitions 现在会读 ~/.vykor/agents：把配置目录指到临时
// 目录，避免开发机上的真实用户 agent 影响断言（环境隔离）。
let cfgDir: string;
beforeAll(() => {
  cfgDir = mkdtempSync(joinPath(tmpdir(), "vk-coord-cfg-"));
  process.env.VYKOR_CONFIG_DIR = cfgDir;
});
afterAll(() => {
  delete process.env.VYKOR_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("Coordinator", () => {
  it("stores config", () => {
    const c = new Coordinator({
      mode: "parallel",
      agents: [{ name: "a", description: "test" }],
    });
    expect(c.getMode()).toBe("parallel");
    expect(c.getAgents()).toHaveLength(1);
  });
});

describe("TeamRegistry", () => {
  it("creates and lists teams", () => {
    const reg = new TeamRegistry();
    const team = reg.createTeam("dev", "Dev team");
    expect(team.name).toBe("dev");
    expect(reg.listTeams()).toHaveLength(1);
  });

  it("rejects duplicate team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("t1");
    expect(() => reg.createTeam("t1")).toThrow("already exists");
  });

  it("deletes a team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("t1");
    reg.deleteTeam("t1");
    expect(reg.listTeams()).toHaveLength(0);
  });

  it("throws deleting nonexistent team", () => {
    const reg = new TeamRegistry();
    expect(() => reg.deleteTeam("nope")).toThrow("does not exist");
  });

  it("adds agents to team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("team");
    reg.addAgent("team", "task-1");
    reg.addAgent("team", "task-1");
    expect(reg.listTeams()[0]!.agents).toEqual(["task-1"]);
  });

  it("sends messages to team", () => {
    const reg = new TeamRegistry();
    reg.createTeam("team");
    reg.sendMessage("team", "hello");
    expect(reg.listTeams()[0]!.messages).toEqual(["hello"]);
  });

  it("lists teams sorted by name", () => {
    const reg = new TeamRegistry();
    reg.createTeam("beta");
    reg.createTeam("alpha");
    expect(reg.listTeams().map((t) => t.name)).toEqual(["alpha", "beta"]);
  });
});

describe("isCoordinatorMode", () => {
  const ENV_KEYS = [
    "VYKOR_COORDINATOR_MODE",
    "CLAUDE_CODE_COORDINATOR_MODE",
    "COORDINATOR_MODE",
    "VYKOR_COORDINATOR",
    "CLAUDE_CODE_COORDINATOR",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("returns false when no env var is set", () => {
    expect(isCoordinatorMode()).toBe(false);
  });

  it("returns true for VYKOR_COORDINATOR_MODE truthy values", () => {
    for (const value of ["1", "true", "yes", "TRUE", "Yes"]) {
      process.env.VYKOR_COORDINATOR_MODE = value;
      expect(isCoordinatorMode()).toBe(true);
      delete process.env.VYKOR_COORDINATOR_MODE;
    }
  });

  it("returns false for VYKOR_COORDINATOR_MODE falsy values", () => {
    for (const value of ["0", "false", "no", "", "off"]) {
      process.env.VYKOR_COORDINATOR_MODE = value;
      expect(isCoordinatorMode()).toBe(false);
      delete process.env.VYKOR_COORDINATOR_MODE;
    }
  });

  it("ignores legacy coordinator env names", () => {
    for (const key of ["CLAUDE_CODE_COORDINATOR_MODE", "COORDINATOR_MODE", "VYKOR_COORDINATOR", "CLAUDE_CODE_COORDINATOR"]) {
      process.env[key] = "1";
      expect(isCoordinatorMode()).toBe(false);
      delete process.env[key];
    }
  });
});

describe("getTeamRegistry", () => {
  it("returns a singleton", () => {
    const a = getTeamRegistry();
    const b = getTeamRegistry();
    expect(a).toBe(b);
  });
});

describe("AgentDefinitions", () => {
  it("has built-in agents", () => {
    const agents = getBuiltinAgentDefinitions();
    expect(agents.length).toBeGreaterThanOrEqual(4);
    const names = agents.map((a) => a.name);
    expect(names).toContain("general-purpose");
    expect(names).toContain("Explore");
    expect(names).toContain("Plan");
    expect(names).toContain("worker");
  });

  it("finds agent by name", () => {
    const agent = getAgentDefinition("Explore");
    expect(agent).toBeDefined();
    expect(agent!.systemPrompt).toContain("READ-ONLY");
  });

  it("returns undefined for unknown agent", () => {
    expect(getAgentDefinition("nonexistent")).toBeUndefined();
  });

  it("inherit-model agents omit a hardcoded model (OpenRouter/non-Anthropic safe)", () => {
    // 对齐 Python v0.1.9：Explore/Plan/verification/claude-code-guide/general-purpose
    // 用 inherit（TS 以省略 model 表示继承会话模型）。硬编码 haiku 会让非 Anthropic
    // provider 解析失败——防回归。
    for (const name of ["Explore", "Plan", "verification", "claude-code-guide", "general-purpose"]) {
      expect(getAgentDefinition(name)!.model).toBeUndefined();
    }
    // statusline-setup 与 Python 一致保留 sonnet（Anthropic 向工具，刻意取舍）。
    expect(getAgentDefinition("statusline-setup")!.model).toBe("sonnet");
  });

  it("has required MCP servers check", () => {
    const agent = { name: "x", description: "", requiredMcpServers: ["github"] };
    expect(hasRequiredMcpServers(agent, ["github-copilot"])).toBe(true);
    expect(hasRequiredMcpServers(agent, ["other"])).toBe(false);
    expect(hasRequiredMcpServers({ name: "y", description: "" }, [])).toBe(true);
  });

  it("ships all 7 built-in agents aligned with the Python original", () => {
    const names = getBuiltinAgentDefinitions().map((a) => a.name);
    expect(names).toEqual([
      "general-purpose",
      "Explore",
      "Plan",
      "worker",
      "verification",
      "statusline-setup",
      "claude-code-guide",
    ]);
  });

  it("every built-in agent has a non-empty system prompt", () => {
    for (const agent of getBuiltinAgentDefinitions()) {
      expect(agent.systemPrompt, agent.name).toBeTruthy();
      expect((agent.systemPrompt ?? "").trim().length, agent.name).toBeGreaterThan(0);
    }
  });

  it("uses runtime tool names in built-in tool policies", () => {
    expect(getAgentDefinition("general-purpose")?.tools).toEqual(["*"]);
    expect(getAgentDefinition("worker")?.tools).toEqual(["*"]);
    expect(getAgentDefinition("worker")?.disallowedTools).toEqual([
      "Agent",
      "JobSend",
      "JobCancel",
      "JobWait",
      "Workflow",
      "TeamCreate",
      "TeamDelete",
    ]);

    for (const name of ["Explore", "Plan"]) {
      expect(getAgentDefinition(name)?.disallowedTools).toEqual([
        "Agent",
        "ExitPlanMode",
        "Shell",
        "Edit",
        "Write",
        "NotebookEdit",
      ]);
    }
    expect(getAgentDefinition("verification")?.disallowedTools).toEqual([
      "Agent",
      "ExitPlanMode",
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
  });
});

// These anchor strings come verbatim from the Python original
// (vykor/coordinator/agent_definitions.py). They guard against the
// prompts being silently truncated again in the future.
describe("built-in agent prompt anchors (Python v0.1.9 alignment)", () => {
  const anchorsByAgent: Record<string, string[]> = {
    "general-purpose": [
      "You are an agent for Claude Code, Anthropic's official CLI for Claude.",
      "the caller will relay this to the user",
      "NEVER proactively create documentation files",
    ],
    Explore: [
      "You are a file search specialist for Claude Code",
      "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
      "Using redirect operators (>, >>, |) or heredocs to write to files",
      "You are meant to be a fast agent that returns output as quickly as possible",
    ],
    Plan: [
      "You are a software architect and planning specialist for Claude Code.",
      "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
      "### Critical Files for Implementation",
      "You CANNOT and MUST NOT write, edit, or modify any files.",
    ],
    worker: [
      "You are an implementation-focused worker agent.",
      "run relevant tests and typecheck, then commit",
    ],
    verification: [
      "You are a verification specialist.",
      "verification avoidance",
      "seduced by the first 80%",
      "=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===",
      "reading is not verification. Run it.",
      "=== ADVERSARIAL PROBES (adapt to the change type) ===",
      "=== BEFORE ISSUING PASS ===",
      "=== BEFORE ISSUING FAIL ===",
      "=== OUTPUT FORMAT (REQUIRED) ===",
      "VERDICT: PASS",
      "VERDICT: FAIL",
      "VERDICT: PARTIAL",
    ],
    "statusline-setup": [
      "You are a status line setup agent for Claude Code.",
      "~/.claude/settings.json",
      '"statusLine"',
      'this "statusline-setup" agent must be used for further status line changes',
    ],
    "claude-code-guide": [
      "You are the Claude guide agent.",
      "Claude Agent SDK",
      "https://code.claude.com/docs/en/claude_code_docs_map.md",
      "https://platform.claude.com/llms.txt",
    ],
  };

  for (const [name, anchors] of Object.entries(anchorsByAgent)) {
    it(`${name} prompt contains all Python anchors`, () => {
      const agent = getAgentDefinition(name);
      expect(agent, name).toBeDefined();
      const prompt = agent!.systemPrompt ?? "";
      for (const anchor of anchors) {
        expect(prompt, `${name} missing anchor: ${anchor}`).toContain(anchor);
      }
    });
  }

  it("verification agent carries its critical reminder and verdict format", () => {
    const agent = getAgentDefinition("verification");
    expect(agent?.criticalSystemReminder).toContain("VERIFICATION-ONLY task");
    expect(agent?.criticalSystemReminder).toContain("VERDICT: PASS");
    expect(agent?.background).toBe(true);
    expect(agent?.color).toBe("red");
  });
});

describe("COORDINATOR_SYSTEM_PROMPT anchors (Python v0.1.9 alignment)", () => {
  const anchors = [
    "You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.",
    "## 1. Your Role",
    "## 2. Your Tools",
    "### agent Results",
    "## 3. Workers",
    "## 4. Task Workflow",
    "### What Real Verification Looks Like",
    "### Stopping Workers",
    "## 5. Writing Worker Prompts",
    "### Always synthesize — your most important job",
    "### Choose continue vs. spawn by context overlap",
    "### Prompt tips",
    "## 6. Example Session",
    "<task-notification>",
    "subscribe_pr_activity / unsubscribe_pr_activity",
    "Parallelism is your superpower",
    "Wait for one or more workers with `JobWait",
  ];

  for (const anchor of anchors) {
    it(`contains: ${anchor.slice(0, 48)}`, () => {
      expect(COORDINATOR_SYSTEM_PROMPT).toContain(anchor);
    });
  }

  it("is substantially longer than the truncated version (>5000 chars)", () => {
    expect(COORDINATOR_SYSTEM_PROMPT.length).toBeGreaterThan(5000);
  });
});
