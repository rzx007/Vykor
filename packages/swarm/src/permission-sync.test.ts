import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type SwarmPermissionRequest,
  generateRequestId,
  createPermissionRequest,
  writePermissionRequest,
  readPendingPermissions,
  readResolvedPermission,
  resolvePermission,
  deleteResolvedPermission,
  cleanupOldResolutions,
  isTeamLeader,
  isSwarmWorker,
  getLeaderName,
  handlePermissionRequest,
  sendPermissionRequest,
  pollPermissionResponse,
  sendPermissionResponse,
} from "./permission-sync.js";
import { TeamLifecycleManager } from "./team-lifecycle.js";

const SWARM_ENV = [
  "CLAUDE_CODE_TEAM_NAME",
  "CLAUDE_CODE_AGENT_ID",
  "CLAUDE_CODE_AGENT_NAME",
  "CLAUDE_CODE_AGENT_COLOR",
] as const;

let team: string;

beforeEach(() => {
  team = `__test_ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for (const key of SWARM_ENV) delete process.env[key];
});

afterEach(() => {
  rmSync(join(homedir(), ".vykor", "teams", team), { recursive: true, force: true });
  for (const key of SWARM_ENV) delete process.env[key];
});

function makeRequest(overrides: Partial<SwarmPermissionRequest> = {}): SwarmPermissionRequest {
  return createPermissionRequest({
    toolName: "Edit",
    toolUseId: "tu-1",
    toolInput: { file_path: "a.ts" },
    teamName: team,
    workerId: "w-1",
    workerName: "worker-1",
    ...overrides,
  });
}

describe("generateRequestId", () => {
  it("matches perm-<ms>-<rand7>", () => {
    expect(generateRequestId()).toMatch(/^perm-\d+-[a-z0-9]{7}$/);
  });
});

describe("createPermissionRequest", () => {
  it("fills explicit fields and starts pending", () => {
    const req = makeRequest();
    expect(req.teamName).toBe(team);
    expect(req.workerId).toBe("w-1");
    expect(req.toolName).toBe("Edit");
    expect(req.status).toBe("pending");
    expect(req.permissionSuggestions).toEqual([]);
  });

  it("falls back to swarm env vars for team/worker identity", () => {
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    process.env.CLAUDE_CODE_AGENT_ID = "env-id";
    process.env.CLAUDE_CODE_AGENT_NAME = "env-name";
    process.env.CLAUDE_CODE_AGENT_COLOR = "blue";
    const req = createPermissionRequest({ toolName: "Bash", toolUseId: "tu", toolInput: {} });
    expect(req.teamName).toBe(team);
    expect(req.workerId).toBe("env-id");
    expect(req.workerName).toBe("env-name");
    expect(req.workerColor).toBe("blue");
  });
});

describe("file-based pending/resolved flow", () => {
  it("writePermissionRequest lands in pending/ and readPendingPermissions returns oldest-first", async () => {
    const older = makeRequest();
    older.createdAt = 100;
    const newer = makeRequest();
    newer.createdAt = 200;
    await writePermissionRequest(newer);
    await writePermissionRequest(older);

    const pending = await readPendingPermissions(team);
    expect(pending.map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  it("resolvePermission moves pending → resolved with resolution fields", async () => {
    const req = makeRequest();
    await writePermissionRequest(req);

    const ok = await resolvePermission(
      req.id,
      { decision: "rejected", resolvedBy: "leader", feedback: "too risky" },
      team,
    );
    expect(ok).toBe(true);
    expect(await readPendingPermissions(team)).toEqual([]);

    const resolved = await readResolvedPermission(req.id, team);
    expect(resolved!.status).toBe("rejected");
    expect(resolved!.resolvedBy).toBe("leader");
    expect(resolved!.feedback).toBe("too risky");
    expect(resolved!.resolvedAt).toBeTypeOf("number");
  });

  it("resolvePermission returns false for an unknown request", async () => {
    new TeamLifecycleManager().createTeam(team);
    expect(await resolvePermission("perm-unknown", { decision: "approved", resolvedBy: "leader" }, team)).toBe(
      false,
    );
  });

  it("deleteResolvedPermission removes the resolved file once", async () => {
    const req = makeRequest();
    await writePermissionRequest(req);
    await resolvePermission(req.id, { decision: "approved", resolvedBy: "leader" }, team);
    expect(await deleteResolvedPermission(req.id, team)).toBe(true);
    expect(await deleteResolvedPermission(req.id, team)).toBe(false);
  });

  it("cleanupOldResolutions removes resolutions older than maxAge (by resolved_at)", async () => {
    const req = makeRequest();
    await writePermissionRequest(req);
    await resolvePermission(req.id, { decision: "approved", resolvedBy: "leader" }, team);

    // 刚 resolve 的不够老。
    expect(await cleanupOldResolutions(team, 3600)).toBe(0);
    // maxAge=0 → 一切 resolved 都算过期。
    expect(await cleanupOldResolutions(team, 0)).toBe(1);
    expect(await readResolvedPermission(req.id, team)).toBeNull();
  });
});

describe("role detection", () => {
  it("isTeamLeader: team set + no agent id (or team-lead) → leader", () => {
    expect(isTeamLeader()).toBe(false); // 无 team
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    expect(isTeamLeader()).toBe(true); // 无 agent id
    process.env.CLAUDE_CODE_AGENT_ID = "team-lead";
    expect(isTeamLeader()).toBe(true);
    process.env.CLAUDE_CODE_AGENT_ID = "w-1";
    expect(isTeamLeader()).toBe(false);
  });

  it("isSwarmWorker requires team + agent id + not leader", () => {
    expect(isSwarmWorker()).toBe(false);
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    expect(isSwarmWorker()).toBe(false);
    process.env.CLAUDE_CODE_AGENT_ID = "w-1";
    expect(isSwarmWorker()).toBe(true);
  });
});

describe("getLeaderName", () => {
  it("resolves the lead member's name from team.json, falling back to team-lead", async () => {
    expect(await getLeaderName(team)).toBeNull(); // 无 team 文件

    const manager = new TeamLifecycleManager();
    manager.createTeam(team);
    expect(await getLeaderName(team)).toBe("team-lead"); // 无 lead 成员

    const file = manager.getTeam(team)!;
    file.leadAgentId = "lead-1";
    file.members["lead-1"] = {
      agentId: "lead-1",
      name: "boss",
      backendType: "subprocess",
      joinedAt: 1,
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
    };
    const { writeTeamFile } = await import("./team-lifecycle.js");
    writeTeamFile(team, file);
    expect(await getLeaderName(team)).toBe("boss");
  });
});

describe("handlePermissionRequest", () => {
  const readOnly = new Set(["Read", "Grep"]);
  const checkerOf = (action: "allow" | "deny" | "ask", reason?: string) => ({
    checkTool: () => ({ action, reason }),
  });

  it("auto-approves read-only tools without consulting the checker", async () => {
    const req = makeRequest({ toolName: "Read" });
    let called = false;
    const checker = {
      checkTool: () => {
        called = true;
        return { action: "deny" as const, reason: "nope" };
      },
    };
    const res = await handlePermissionRequest(req, checker, readOnly);
    expect(res.allowed).toBe(true);
    expect(called).toBe(false);
  });

  it("maps checker allow→approved, deny/ask→rejected with reason", async () => {
    expect((await handlePermissionRequest(makeRequest(), checkerOf("allow"), readOnly)).allowed).toBe(true);

    const denied = await handlePermissionRequest(makeRequest(), checkerOf("deny", "blacklisted"), readOnly);
    expect(denied.allowed).toBe(false);
    expect(denied.feedback).toBe("blacklisted");

    const asked = await handlePermissionRequest(makeRequest(), checkerOf("ask", "needs confirm"), readOnly);
    expect(asked.allowed).toBe(false);
    expect(asked.feedback).toBe("needs confirm");
  });
});

describe("mailbox-based request/response roundtrip", () => {
  it("worker sends request to leader mailbox, leader responds, worker polls it back", async () => {
    const req = makeRequest();
    await sendPermissionRequest(req, team, "w-1", "leader");

    // leader 侧：读到请求后回 approved。
    await sendPermissionResponse(
      { requestId: req.id, allowed: true, feedback: null, updatedRules: [] },
      team,
      "w-1",
      "leader",
    );

    const response = await pollPermissionResponse(team, "w-1", req.id, {
      timeoutMs: 2_000,
      intervalMs: 20,
    });
    expect(response).not.toBeNull();
    expect(response!.allowed).toBe(true);
  });

  it("pollPermissionResponse times out to null when nothing arrives", async () => {
    const result = await pollPermissionResponse(team, "w-1", "perm-none", {
      timeoutMs: 150,
      intervalMs: 30,
    });
    expect(result).toBeNull();
  });
});
