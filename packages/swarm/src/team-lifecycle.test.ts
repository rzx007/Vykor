import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  type TeamMember,
  sanitizeName,
  sanitizeAgentName,
  readTeamFile,
  writeTeamFile,
  TeamLifecycleManager,
  removeTeammateFromTeamFile,
  removeMemberByAgentId,
  setMemberMode,
  setMultipleMemberModes,
  syncTeammateMode,
  setMemberActive,
  registerTeammateInTeamFile,
  registerTeamForSessionCleanup,
  unregisterTeamForSessionCleanup,
  cleanupSessionTeams,
  cleanupSessionTeamsSync,
  cleanupTeamDirectories,
} from "./team-lifecycle.js";

// 与 mailbox 测试同一套约定：唯一团队名写真实 ~/.vykor/teams，用后清理。
const createdTeams: string[] = [];

function uniqueTeam(): string {
  const name = `__test_tl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdTeams.push(name);
  return name;
}

function teamJsonPath(team: string): string {
  return join(homedir(), ".vykor", "teams", team, "team.json");
}

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agentId: "agent-1",
    name: "worker-1",
    backendType: "subprocess",
    joinedAt: 1000,
    agentType: null,
    model: null,
    prompt: null,
    color: null,
    planModeRequired: false,
    sessionId: null,
    subscriptions: [],
    isActive: true,
    mode: null,
    cwd: "",
    worktreePath: null,
    permissions: [],
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_TEAM_NAME;
  delete process.env.CLAUDE_CODE_AGENT_NAME;
});

afterEach(async () => {
  for (const team of createdTeams.splice(0)) {
    unregisterTeamForSessionCleanup(team);
    rmSync(join(homedir(), ".vykor", "teams", team), { recursive: true, force: true });
  }
  delete process.env.CLAUDE_CODE_TEAM_NAME;
  delete process.env.CLAUDE_CODE_AGENT_NAME;
});

describe("name sanitisation", () => {
  it("sanitizeName lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(sanitizeName("My Team!Name")).toBe("my-team-name");
  });

  it("sanitizeAgentName only replaces @", () => {
    expect(sanitizeAgentName("worker@team")).toBe("worker-team");
    expect(sanitizeAgentName("Worker_1")).toBe("Worker_1");
  });
});

describe("TeamLifecycleManager CRUD", () => {
  it("createTeam persists team.json with snake_case keys", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team, "a test team");

    const raw = JSON.parse(readFileSync(teamJsonPath(team), "utf-8"));
    expect(raw.name).toBe(team);
    expect(raw.description).toBe("a test team");
    expect(raw.created_at).toBeTypeOf("number");
    expect(raw.lead_agent_id).toBe("");
    expect(raw.members).toEqual({});
  });

  it("createTeam throws when the team already exists", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    expect(() => manager.createTeam(team)).toThrow(/already exists/);
  });

  it("getTeam returns null for missing data and rejects corrupted data", () => {
    const manager = new TeamLifecycleManager();
    // 旧实现的 getTeamDir 读路径也 mkdir，可能留有历史空目录：先清掉再验证。
    rmSync(join(homedir(), ".vykor", "teams", "__test_tl_never_created"), { recursive: true, force: true });
    expect(manager.getTeam("__test_tl_never_created")).toBeNull();
    // 查询不存在的团队不应留下空目录（getTeamDir 读路径不再 mkdir）。
    expect(existsSync(join(homedir(), ".vykor", "teams", "__test_tl_never_created"))).toBe(false);

    const team = uniqueTeam();
    mkdirSync(join(homedir(), ".vykor", "teams", team), { recursive: true });
    writeFileSync(teamJsonPath(team), "not json");
    expect(() => manager.getTeam(team)).toThrow();
  });

  it("deleteTeam removes the whole team directory and throws if missing", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.deleteTeam(team);
    expect(existsSync(teamJsonPath(team))).toBe(false);
    expect(() => manager.deleteTeam(team)).toThrow(/does not exist/);
  });

  it("listTeams includes created teams sorted by directory name", () => {
    // 同毫秒生成的两个名字随机后缀顺序不定：显式排序保证 a < b（曾偶发 flake）。
    const [a, b] = [uniqueTeam(), uniqueTeam()].sort() as [string, string];
    const manager = new TeamLifecycleManager();
    manager.createTeam(b);
    manager.createTeam(a);
    const names = manager.listTeams().map((t) => t.name);
    expect(names).toContain(a);
    expect(names).toContain(b);
    expect(names.indexOf(a)).toBeLessThan(names.indexOf(b));
  });
});

describe("member management", () => {
  it("addMember persists and replaces members with the same agentId", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember());
    manager.addMember(team, makeMember({ name: "renamed" }));

    const file = manager.getTeam(team)!;
    expect(Object.keys(file.members)).toEqual(["agent-1"]);
    expect(file.members["agent-1"]!.name).toBe("renamed");
  });

  it("addMember throws for a missing team", () => {
    expect(() => new TeamLifecycleManager().addMember("__test_tl_nope", makeMember())).toThrow(
      /does not exist/,
    );
  });

  it("removeMember deletes by agentId and throws when absent", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember());
    manager.removeMember(team, "agent-1");
    expect(manager.getTeam(team)!.members).toEqual({});
    expect(() => manager.removeMember(team, "agent-1")).toThrow(/not a member/);
  });

  it("removeTeammateFromTeamFile matches by agentId or name", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember({ agentId: "a1", name: "alice" }));
    manager.addMember(team, makeMember({ agentId: "a2", name: "bob" }));

    expect(removeTeammateFromTeamFile(team, { name: "alice" })).toBe(true);
    expect(removeTeammateFromTeamFile(team, { agentId: "a2" })).toBe(true);
    expect(removeTeammateFromTeamFile(team, { name: "ghost" })).toBe(false);
    expect(manager.getTeam(team)!.members).toEqual({});
  });

  it("removeMemberByAgentId returns false when team or member is missing", () => {
    const team = uniqueTeam();
    new TeamLifecycleManager().createTeam(team);
    expect(removeMemberByAgentId(team, "ghost")).toBe(false);
    expect(removeMemberByAgentId("__test_tl_nope", "x")).toBe(false);
  });
});

describe("mode and active-status helpers", () => {
  it("setMemberMode updates by member *name* and persists", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember({ agentId: "a1", name: "alice" }));

    expect(setMemberMode(team, "alice", "full_auto")).toBe(true);
    expect(manager.getTeam(team)!.members["a1"]!.mode).toBe("full_auto");
    expect(setMemberMode(team, "ghost", "x")).toBe(false);
    expect(setMemberMode("__test_tl_nope", "alice", "x")).toBe(false);
  });

  it("setMultipleMemberModes applies a batch in one write", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember({ agentId: "a1", name: "alice" }));
    manager.addMember(team, makeMember({ agentId: "a2", name: "bob" }));

    expect(
      setMultipleMemberModes(team, [
        { memberName: "alice", mode: "plan" },
        { memberName: "bob", mode: "default" },
      ]),
    ).toBe(true);
    const file = manager.getTeam(team)!;
    expect(file.members["a1"]!.mode).toBe("plan");
    expect(file.members["a2"]!.mode).toBe("default");
  });

  it("syncTeammateMode reads team/agent from env and is a no-op without them", () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember({ agentId: "a1", name: "alice" }));

    syncTeammateMode("full_auto"); // env 未设 → no-op
    expect(manager.getTeam(team)!.members["a1"]!.mode).toBeNull();

    process.env.CLAUDE_CODE_TEAM_NAME = team;
    process.env.CLAUDE_CODE_AGENT_NAME = "alice";
    syncTeammateMode("full_auto");
    expect(manager.getTeam(team)!.members["a1"]!.mode).toBe("full_auto");
  });

  it("setMemberActive flips is_active by member name", async () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    manager.addMember(team, makeMember({ agentId: "a1", name: "alice", isActive: true }));
    await setMemberActive(team, "alice", false);
    expect(manager.getTeam(team)!.members["a1"]!.isActive).toBe(false);
  });
});

describe("current serialization format", () => {
  it("writes versioned snake_case and rejects unversioned data", () => {
    const team = uniqueTeam();
    new TeamLifecycleManager().createTeam(team);
    writeTeamFile(team, {
      name: team,
      description: "",
      createdAt: 1,
      leadAgentId: "lead-1",
      leadSessionId: null,
      members: { m1: makeMember({ agentId: "m1", worktreePath: "/wt" }) },
      teamAllowedPaths: [],
      allowedPaths: [],
      metadata: {},
    });

    const raw = JSON.parse(readFileSync(teamJsonPath(team), "utf-8"));
    expect(raw.schema_version).toBe(1);
    expect(raw.lead_agent_id).toBe("lead-1");
    expect(raw.members.m1.agent_id).toBe("m1");
    expect(raw.members.m1.worktree_path).toBe("/wt");

    writeFileSync(
      teamJsonPath(team),
      JSON.stringify({
        name: team,
        createdAt: 2,
        leadAgentId: "lead-camel",
        members: {
          m2: { agentId: "m2", name: "n", backendType: "subprocess", joinedAt: 3 },
        },
      }),
    );
    expect(() => readTeamFile(team)).toThrow("Unsupported team data schema version");
  });
});

describe("registerTeammateInTeamFile", () => {
  it("creates the team on first use, adds the member, and registers session cleanup", async () => {
    const team = uniqueTeam();
    registerTeammateInTeamFile(team, makeMember({ agentId: "w1@t", name: "w1", worktreePath: "/wt" }));

    const file = readTeamFile(team)!;
    expect(file.members["w1@t"]!.worktreePath).toBe("/wt");

    // 已登记会话清理：cleanupSessionTeams 会删掉它。
    await cleanupSessionTeams();
    expect(readTeamFile(team)).toBeNull();
  });

  it("reuses an existing team without throwing and replaces same-id members", () => {
    const team = uniqueTeam();
    new TeamLifecycleManager().createTeam(team);
    registerTeammateInTeamFile(team, makeMember({ agentId: "a", name: "one" }));
    registerTeammateInTeamFile(team, makeMember({ agentId: "a", name: "two" }));
    expect(readTeamFile(team)!.members["a"]!.name).toBe("two");
    // 不是本会话建的团队 → 不应被 session cleanup 登记删除（unregister 兜底在 afterEach）。
  });
});

describe("cleanup", () => {
  it("cleanupTeamDirectories removes member worktrees and the team dir", async () => {
    const team = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    const fakeWorktree = join(tmpdir(), `vk-wt-${Date.now()}`);
    mkdirSync(fakeWorktree, { recursive: true });
    manager.addMember(team, makeMember({ worktreePath: fakeWorktree }));

    await cleanupTeamDirectories(team);
    expect(existsSync(teamJsonPath(team))).toBe(false);
    expect(existsSync(fakeWorktree)).toBe(false);
  });

  it("cleanupSessionTeams removes registered teams only, and unregister opts out", async () => {
    const kept = uniqueTeam();
    const gone = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(kept);
    manager.createTeam(gone);
    registerTeamForSessionCleanup(kept);
    registerTeamForSessionCleanup(gone);
    unregisterTeamForSessionCleanup(kept);

    await cleanupSessionTeams();
    expect(existsSync(teamJsonPath(kept))).toBe(true);
    expect(existsSync(teamJsonPath(gone))).toBe(false);

    // 幂等：再次调用不抛错。
    await cleanupSessionTeams();
  });

  it("cleanupSessionTeamsSync removes registered teams synchronously (exit-hook safe)", () => {
    const team1 = uniqueTeam();
    const manager = new TeamLifecycleManager();
    manager.createTeam(team1);
    const fakeWorktree = join(tmpdir(), `vk-wt-sync-${Date.now()}`);
    mkdirSync(fakeWorktree, { recursive: true });
    manager.addMember(team1, makeMember({ worktreePath: fakeWorktree }));
    registerTeamForSessionCleanup(team1);

    cleanupSessionTeamsSync();
    expect(existsSync(teamJsonPath(team1))).toBe(false);
    expect(existsSync(fakeWorktree)).toBe(false);
    // 幂等。
    cleanupSessionTeamsSync();
  });
});
