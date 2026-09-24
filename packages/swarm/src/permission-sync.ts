import { promises as fs, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { exclusiveFileLock } from "./lockfile.js";
import {
  type MailboxMessage,
  TeammateMailbox,
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  getTeamDir,
  writeToMailbox,
} from "./mailbox.js";
import { readTeamFile } from "./team-lifecycle.js";

/**
 * 权限同步（移植自 Python swarm/permission_sync.py）：worker 与 leader 之间的
 * 权限请求/裁决协调，文件目录与邮箱双轨。
 *
 * 文件流（目录存储）：
 *   1. worker `writePermissionRequest()` → permissions/pending/<id>.json
 *   2. leader `readPendingPermissions()` 列出待裁决
 *   3. leader `resolvePermission()` → 搬移到 permissions/resolved/<id>.json
 *   4. worker `readResolvedPermission(id)` 取回
 *
 * 邮箱流：send/poll 系列直接读写双方收件箱（见 mailbox.ts）。
 *
 * 角色检测沿用 Python 的环境变量：CLAUDE_CODE_TEAM_NAME / CLAUDE_CODE_AGENT_ID /
 * CLAUDE_CODE_AGENT_NAME / CLAUDE_CODE_AGENT_COLOR。
 */

// ---------------------------------------------------------------------------
// 环境助手
// ---------------------------------------------------------------------------

const getTeamName = (): string | undefined => process.env.CLAUDE_CODE_TEAM_NAME || undefined;
const getAgentId = (): string | undefined => process.env.CLAUDE_CODE_AGENT_ID || undefined;
const getAgentName = (): string | undefined => process.env.CLAUDE_CODE_AGENT_NAME || undefined;
const getTeammateColor = (): string | undefined => process.env.CLAUDE_CODE_AGENT_COLOR || undefined;

// ---------------------------------------------------------------------------
// 数据模型（TS 属性 camelCase，落盘只使用当前 snake_case 格式）
// ---------------------------------------------------------------------------

export interface SwarmPermissionRequest {
  id: string;
  workerId: string;
  workerName: string;
  teamName: string;
  toolName: string;
  toolUseId: string;
  description: string;
  input: Record<string, unknown>;
  permissionSuggestions: unknown[];
  workerColor: string | null;
  status: "pending" | "approved" | "rejected";
  resolvedBy: "worker" | "leader" | null;
  resolvedAt: number | null;
  feedback: string | null;
  updatedInput: Record<string, unknown> | null;
  permissionUpdates: unknown[] | null;
  createdAt: number;
}

export interface PermissionResolution {
  decision: "approved" | "rejected";
  resolvedBy: "worker" | "leader";
  feedback?: string | null;
  updatedInput?: Record<string, unknown> | null;
  permissionUpdates?: unknown[] | null;
}

export interface SwarmPermissionResponse {
  requestId: string;
  allowed: boolean;
  feedback: string | null;
  updatedRules: unknown[];
}

/** 结构化裁决接口：对齐 @vykor/permissions 的 PermissionChecker.checkTool，避免跨包依赖。 */
export interface PermissionDecider {
  checkTool(
    toolName: string,
    input: Record<string, unknown>,
  ):
    | { action: "allow" | "deny" | "ask"; reason?: string }
    | Promise<{ action: "allow" | "deny" | "ask"; reason?: string }>;
}

type Raw = Record<string, unknown>;

function pick<T>(data: Raw, key: string, fallback: T): T {
  if (key in data && data[key] !== undefined) return data[key] as T;
  return fallback;
}

function requestToRaw(r: SwarmPermissionRequest): Raw {
  return {
    schema_version: 1,
    id: r.id,
    worker_id: r.workerId,
    worker_name: r.workerName,
    team_name: r.teamName,
    tool_name: r.toolName,
    tool_use_id: r.toolUseId,
    description: r.description,
    input: r.input,
    permission_suggestions: r.permissionSuggestions,
    worker_color: r.workerColor,
    status: r.status,
    resolved_by: r.resolvedBy,
    resolved_at: r.resolvedAt,
    feedback: r.feedback,
    updated_input: r.updatedInput,
    permission_updates: r.permissionUpdates,
    created_at: r.createdAt,
  };
}

function requestFromRaw(data: Raw): SwarmPermissionRequest {
  if (data.schema_version !== 1) {
    throw new Error(`Unsupported permission data schema version: ${String(data.schema_version)}`);
  }
  const required = [
    "id", "worker_id", "worker_name", "team_name", "tool_name", "tool_use_id", "description",
    "input", "permission_suggestions", "worker_color", "status", "resolved_by", "resolved_at",
    "feedback", "updated_input", "permission_updates", "created_at",
  ];
  const missing = required.filter((field) => !(field in data));
  if (missing.length > 0) {
    throw new Error(`Permission record is missing required fields: ${missing.join(", ")}`);
  }
  return {
    id: typeof data.id === "string" ? data.id : "",
    workerId: pick(data, "worker_id", ""),
    workerName: pick(data, "worker_name", ""),
    teamName: pick(data, "team_name", ""),
    toolName: pick(data, "tool_name", ""),
    toolUseId: pick(data, "tool_use_id", ""),
    description: typeof data.description === "string" ? data.description : "",
    input: (data.input ?? {}) as Record<string, unknown>,
    permissionSuggestions: pick(data, "permission_suggestions", []),
    workerColor: pick<string | null>(data, "worker_color", null),
    status: pick(data, "status", "pending" as const),
    resolvedBy: pick<"worker" | "leader" | null>(data, "resolved_by", null),
    resolvedAt: pick<number | null>(data, "resolved_at", null),
    feedback: typeof data.feedback === "string" ? data.feedback : null,
    updatedInput: pick<Record<string, unknown> | null>(data, "updated_input", null),
    permissionUpdates: pick<unknown[] | null>(data, "permission_updates", null),
    createdAt: pick(data, "created_at", Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// 请求 ID
// ---------------------------------------------------------------------------

/** `perm-<毫秒时间戳>-<rand7>`（对齐 Python/TS 参考实现格式）。 */
export function generateRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 9).padEnd(7, "0");
  return `perm-${Date.now()}-${rand}`;
}

// ---------------------------------------------------------------------------
// 目录助手
// ---------------------------------------------------------------------------

function getPendingDir(teamName: string): string {
  return join(getTeamDir(teamName), "permissions", "pending");
}

function getResolvedDir(teamName: string): string {
  return join(getTeamDir(teamName), "permissions", "resolved");
}

function ensurePermissionDirs(teamName: string): void {
  mkdirSync(getPendingDir(teamName), { recursive: true });
  mkdirSync(getResolvedDir(teamName), { recursive: true });
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/** 缺省字段从 swarm 环境变量补齐。 */
export function createPermissionRequest(options: {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  description?: string;
  permissionSuggestions?: unknown[];
  teamName?: string;
  workerId?: string;
  workerName?: string;
  workerColor?: string;
}): SwarmPermissionRequest {
  return {
    id: generateRequestId(),
    workerId: options.workerId ?? getAgentId() ?? "",
    workerName: options.workerName ?? getAgentName() ?? "",
    workerColor: options.workerColor ?? getTeammateColor() ?? null,
    teamName: options.teamName ?? getTeamName() ?? "",
    toolName: options.toolName,
    toolUseId: options.toolUseId,
    description: options.description ?? "",
    input: options.toolInput,
    permissionSuggestions: options.permissionSuggestions ?? [],
    status: "pending",
    resolvedBy: null,
    resolvedAt: null,
    feedback: null,
    updatedInput: null,
    permissionUpdates: null,
    createdAt: Date.now() / 1000,
  };
}

// ---------------------------------------------------------------------------
// 文件流：写 / 读 / 裁决 / 清理
// ---------------------------------------------------------------------------

/** worker：把请求落到 pending/（锁内原子写）。 */
export async function writePermissionRequest(
  request: SwarmPermissionRequest,
): Promise<SwarmPermissionRequest> {
  ensurePermissionDirs(request.teamName);
  const pendingPath = join(getPendingDir(request.teamName), `${request.id}.json`);
  const lockPath = join(getPendingDir(request.teamName), ".lock");
  const tmpPath = `${pendingPath}.tmp`;

  await exclusiveFileLock(lockPath, async () => {
    await fs.writeFile(tmpPath, JSON.stringify(requestToRaw(request), null, 2), "utf-8");
    await fs.rename(tmpPath, pendingPath);
  });
  return request;
}

/** leader：列出团队全部待裁决请求（oldest-first）。 */
export async function readPendingPermissions(teamName?: string): Promise<SwarmPermissionRequest[]> {
  const team = teamName ?? getTeamName();
  if (!team) return [];

  const pendingDir = getPendingDir(team);
  if (!existsSync(pendingDir)) return [];

  const requests: SwarmPermissionRequest[] = [];
  for (const name of (await fs.readdir(pendingDir)).sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    requests.push(requestFromRaw(JSON.parse(await fs.readFile(join(pendingDir, name), "utf-8")) as Raw));
  }
  requests.sort((a, b) => a.createdAt - b.createdAt);
  return requests;
}

/** worker：按 ID 查已裁决请求；未裁决返回 null。 */
export async function readResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<SwarmPermissionRequest | null> {
  const team = teamName ?? getTeamName();
  if (!team) return null;

  const resolvedPath = join(getResolvedDir(team), `${requestId}.json`);
  try {
    return requestFromRaw(JSON.parse(await fs.readFile(resolvedPath, "utf-8")) as Raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** leader：裁决并把请求从 pending/ 搬到 resolved/（锁内原子）。 */
export async function resolvePermission(
  requestId: string,
  resolution: PermissionResolution,
  teamName?: string,
): Promise<boolean> {
  const team = teamName ?? getTeamName();
  if (!team) return false;

  ensurePermissionDirs(team);
  const pendingPath = join(getPendingDir(team), `${requestId}.json`);
  const resolvedPath = join(getResolvedDir(team), `${requestId}.json`);
  const lockPath = join(getPendingDir(team), ".lock");
  const tmpPath = `${resolvedPath}.tmp`;

  return exclusiveFileLock(lockPath, async () => {
    let request: SwarmPermissionRequest;
    try {
      request = requestFromRaw(JSON.parse(await fs.readFile(pendingPath, "utf-8")) as Raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    const resolved: SwarmPermissionRequest = {
      ...request,
      status: resolution.decision === "approved" ? "approved" : "rejected",
      resolvedBy: resolution.resolvedBy,
      resolvedAt: Date.now() / 1000,
      feedback: resolution.feedback ?? null,
      updatedInput: resolution.updatedInput ?? null,
      permissionUpdates: resolution.permissionUpdates ?? null,
    };

    await fs.writeFile(tmpPath, JSON.stringify(requestToRaw(resolved), null, 2), "utf-8");
    await fs.rename(tmpPath, resolvedPath);
    await fs.unlink(pendingPath).catch(() => {});
    return true;
  });
}

/** worker：处理完后删除 resolved 文件。 */
export async function deleteResolvedPermission(requestId: string, teamName?: string): Promise<boolean> {
  const team = teamName ?? getTeamName();
  if (!team) return false;

  try {
    await fs.unlink(join(getResolvedDir(team), `${requestId}.json`));
    return true;
  } catch {
    return false;
  }
}

/** 周期清理过老的 resolved 文件，返回删除数。 */
export async function cleanupOldResolutions(teamName?: string, maxAgeSeconds = 3600): Promise<number> {
  const team = teamName ?? getTeamName();
  if (!team) return 0;

  const resolvedDir = getResolvedDir(team);
  if (!existsSync(resolvedDir)) return 0;

  const now = Date.now() / 1000;
  let cleaned = 0;
  for (const name of readdirSync(resolvedDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(resolvedDir, name);
    try {
      const data = JSON.parse(await fs.readFile(path, "utf-8")) as Raw;
      const request = requestFromRaw(data);
      const resolvedAt = request.resolvedAt ?? request.createdAt;
      if (now - resolvedAt >= maxAgeSeconds) {
        await fs.unlink(path);
        cleaned += 1;
      }
    } catch (error) {
      throw new Error(`Cannot clean invalid permission record: ${path}`, { cause: error });
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// 角色检测 / leader 寻址
// ---------------------------------------------------------------------------

/** leader = 设了 team 但没有 agent id（或 id 就是 "team-lead"）。 */
export function isTeamLeader(teamName?: string): boolean {
  const team = teamName ?? getTeamName();
  if (!team) return false;
  const agentId = getAgentId();
  return !agentId || agentId === "team-lead";
}

export function isSwarmWorker(): boolean {
  return Boolean(getTeamName()) && Boolean(getAgentId()) && !isTeamLeader();
}

/** 从 team.json 反查 leader 名字（寻址其邮箱用）；lead 成员缺失时回退 "team-lead"。 */
export async function getLeaderName(teamName?: string): Promise<string | null> {
  const team = teamName ?? getTeamName();
  if (!team) return null;

  const teamFile = readTeamFile(team);
  if (!teamFile) return null;

  const leadId = teamFile.leadAgentId;
  if (leadId && leadId in teamFile.members) {
    return teamFile.members[leadId]!.name;
  }
  return "team-lead";
}

// ---------------------------------------------------------------------------
// leader 裁决（对齐 Python handle_permission_request 语义）
// ---------------------------------------------------------------------------

/**
 * 只读工具直接批；其余走 leader 的 checkTool：allow→批、deny/ask→拒（带 reason）。
 * `ask` 视为「leader 也做不了主」保守拒——leader 开 full_auto/白名单时写操作才放行。
 * readOnlyTools 由调用方传入（接线处用 @vykor/permissions 的 READ_ONLY_TOOLS）。
 */
export async function handlePermissionRequest(
  request: SwarmPermissionRequest,
  checker: PermissionDecider,
  readOnlyTools: ReadonlySet<string>,
): Promise<SwarmPermissionResponse> {
  if (readOnlyTools.has(request.toolName)) {
    return { requestId: request.id, allowed: true, feedback: null, updatedRules: [] };
  }

  const decision = await checker.checkTool(request.toolName, request.input);
  const allowed = decision.action === "allow";
  return {
    requestId: request.id,
    allowed,
    feedback: allowed ? null : (decision.reason ?? "Permission denied"),
    updatedRules: [],
  };
}

// ---------------------------------------------------------------------------
// 邮箱流：结构化 payload 收发
// ---------------------------------------------------------------------------

function structuredMessage(
  type: "permission_request" | "permission_response",
  sender: string,
  recipient: string,
  payload: Record<string, unknown>,
): MailboxMessage {
  return {
    schemaVersion: 1,
    id: generateRequestId(),
    type,
    sender,
    recipient,
    payload,
    timestamp: Date.now() / 1000,
    read: false,
  };
}

/** worker：把请求序列化写进 leader 邮箱（结构化 payload 版）。 */
export async function sendPermissionRequest(
  request: SwarmPermissionRequest,
  teamName: string,
  workerId: string,
  leaderId = "leader",
): Promise<void> {
  const msg = structuredMessage("permission_request", workerId, leaderId, {
    request_id: request.id,
    tool_name: request.toolName,
    tool_use_id: request.toolUseId,
    input: request.input,
    description: request.description,
    permission_suggestions: request.permissionSuggestions,
    worker_id: workerId,
  });
  await new TeammateMailbox(teamName, leaderId).write(msg);
}

/** worker：轮询自己邮箱直到匹配 request_id 的 permission_response 到达或超时。 */
export async function pollPermissionResponse(
  teamName: string,
  workerId: string,
  requestId: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<SwarmPermissionResponse | null> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 500;
  const mailbox = new TeammateMailbox(teamName, workerId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = await mailbox.readAll(true);
    for (const msg of messages) {
      if (msg.type !== "permission_response") continue;
      if (msg.payload.request_id !== requestId) continue;
      await mailbox.markRead(msg.id);
      return {
        requestId,
        allowed: msg.payload.allowed === true,
        feedback: typeof msg.payload.feedback === "string" ? msg.payload.feedback : null,
        updatedRules: Array.isArray(msg.payload.updated_rules) ? msg.payload.updated_rules : [],
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** leader：把裁决写回 worker 邮箱（结构化 payload 版）。 */
export async function sendPermissionResponse(
  response: SwarmPermissionResponse,
  teamName: string,
  workerId: string,
  leaderId = "leader",
): Promise<void> {
  const msg = structuredMessage("permission_response", leaderId, workerId, {
    request_id: response.requestId,
    allowed: response.allowed,
    feedback: response.feedback,
    updated_rules: response.updatedRules,
  });
  await new TeammateMailbox(teamName, workerId).write(msg);
}

// ---------------------------------------------------------------------------
// 邮箱流：text 信封版（对齐 Python send_*_via_mailbox）
// ---------------------------------------------------------------------------

/** worker：经 writeToMailbox 信封格式把请求发给 leader（按 team.json 寻址）。 */
export async function sendPermissionRequestViaMailbox(request: SwarmPermissionRequest): Promise<boolean> {
  const leaderName = await getLeaderName(request.teamName);
  if (!leaderName) return false;

  try {
    const msg = createPermissionRequestMessage(request.workerName, leaderName, {
      request_id: request.id,
      agent_id: request.workerName,
      tool_name: request.toolName,
      tool_use_id: request.toolUseId,
      description: request.description,
      input: request.input,
      permission_suggestions: request.permissionSuggestions,
    });
    await writeToMailbox(
      leaderName,
      {
        from: request.workerName,
        text: JSON.stringify(msg.payload),
        timestamp: new Date().toISOString(),
        color: request.workerColor,
      },
      request.teamName,
    );
    return true;
  } catch {
    return false;
  }
}

/** leader：经信封格式把裁决发回 worker。 */
export async function sendPermissionResponseViaMailbox(
  workerName: string,
  resolution: PermissionResolution,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName ?? getTeamName();
  if (!team) return false;

  const senderName = getAgentName() ?? "team-lead";
  const subtype = resolution.decision === "approved" ? "success" : "error";

  try {
    const msg = createPermissionResponseMessage(senderName, workerName, {
      request_id: requestId,
      subtype,
      error: subtype === "error" ? (resolution.feedback ?? "Permission denied") : undefined,
      updated_input: resolution.updatedInput,
      permission_updates: resolution.permissionUpdates,
    });
    await writeToMailbox(
      workerName,
      {
        from: senderName,
        text: JSON.stringify(msg.payload),
        timestamp: new Date().toISOString(),
      },
      team,
    );
    return true;
  } catch {
    return false;
  }
}
