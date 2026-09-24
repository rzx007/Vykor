import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { exclusiveFileLock } from "./lockfile.js";

/**
 * 文件式邮箱（移植自 Python swarm/mailbox.py）：leader/worker 跨进程通信的底座。
 *
 * 每条消息一个 JSON 文件：
 *   ~/.vykor/teams/<team>/agents/<agentId>/inbox/<timestamp>_<msgId>.json
 *
 * 原子写：先写 `.tmp` 再 rename，读者永远看不到半截消息；写/改/删都在
 * `.write_lock` 排他锁内进行（见 lockfile.ts）。
 */

export type MessageType =
  | "user_message"
  | "permission_request"
  | "permission_response"
  | "sandbox_permission_request"
  | "sandbox_permission_response"
  | "shutdown"
  | "idle_notification";

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "user_message",
  "permission_request",
  "permission_response",
  "sandbox_permission_request",
  "sandbox_permission_response",
  "shutdown",
  "idle_notification",
]);

export interface MailboxMessage {
  schemaVersion: 1;
  id: string;
  type: MessageType;
  sender: string;
  recipient: string;
  payload: Record<string, unknown>;
  timestamp: number;
  read: boolean;
}

// ---------------------------------------------------------------------------
// 目录助手（与 Python get_team_dir 不同：默认纯路径计算，写路径显式 ensure。
// Python 的「调用即建目录」让查询不存在的团队也留下空目录）
// ---------------------------------------------------------------------------

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._@-]+$/;

/**
 * 校验拼进 teams 路径的名字（team/agentId 来自 LLM 工具入参与环境变量）。
 * 不安全的名字（路径分隔符、`..` 等）直接抛错——这些目录会在会话退出时被
 * 递归删除，穿越出 teams 根目录等于任意目录删除。Python 原版未接线所以没暴露
 * 这一面；TS 接线后必须收紧（sanitize_name 在 Python 中也是定义而未用）。
 */
function assertSafePathComponent(name: string, what: string): void {
  if (!SAFE_PATH_COMPONENT.test(name) || name === "." || name === "..") {
    throw new Error(`Unsafe ${what} for filesystem path: ${JSON.stringify(name)}`);
  }
}

export function getTeamDir(teamName: string, options?: { ensure?: boolean }): string {
  assertSafePathComponent(teamName, "team name");
  const dir = join(homedir(), ".vykor", "teams", teamName);
  if (options?.ensure) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAgentMailboxDir(
  teamName: string,
  agentId: string,
  options?: { ensure?: boolean },
): string {
  assertSafePathComponent(agentId, "agent id");
  const dir = join(getTeamDir(teamName), "agents", agentId, "inbox");
  if (options?.ensure) mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// TeammateMailbox
// ---------------------------------------------------------------------------

function parseMessage(data: Record<string, unknown>): MailboxMessage {
  if (data.schemaVersion !== 1) {
    throw new Error(`Unsupported mailbox message schema version: ${String(data.schemaVersion)}`);
  }
  if (typeof data.id !== "string" || typeof data.timestamp !== "number") {
    throw new Error("Mailbox message is missing a valid id or timestamp");
  }
  if (typeof data.type !== "string" || !MESSAGE_TYPES.has(data.type)) {
    throw new Error(`Mailbox message has an invalid type: ${String(data.type)}`);
  }
  if (typeof data.sender !== "string" || typeof data.recipient !== "string" || !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload) || typeof data.read !== "boolean") {
    throw new Error("Mailbox message contains invalid sender, recipient, payload, or read fields");
  }
  return {
    schemaVersion: 1,
    id: data.id,
    type: data.type as MessageType,
    sender: data.sender,
    recipient: data.recipient,
    payload: data.payload as Record<string, unknown>,
    timestamp: data.timestamp,
    read: data.read,
  };
}

export class TeammateMailbox {
  constructor(
    public readonly teamName: string,
    public readonly agentId: string,
  ) {}

  getMailboxDir(): string {
    return getAgentMailboxDir(this.teamName, this.agentId);
  }

  private lockPath(): string {
    return join(this.getMailboxDir(), ".write_lock");
  }

  /** 锁内 `.tmp` + rename 原子写；文件名 <timestamp>_<id>.json（6 位小数，字典序≈时间序）。 */
  async write(msg: MailboxMessage): Promise<void> {
    const inbox = getAgentMailboxDir(this.teamName, this.agentId, { ensure: true });
    const filename = `${msg.timestamp.toFixed(6)}_${msg.id}.json`;
    const finalPath = join(inbox, filename);
    const tmpPath = `${finalPath}.tmp`;
    const payload = JSON.stringify(msg, null, 2);

    await exclusiveFileLock(this.lockPath(), async () => {
      await fs.writeFile(tmpPath, payload, "utf-8");
      await fs.rename(tmpPath, finalPath);
    });
  }

  /** 按文件名（≈时间）排序返回；跳过点文件/.tmp；收件箱不存在视为空。 */
  async readAll(unreadOnly = true): Promise<MailboxMessage[]> {
    const inbox = this.getMailboxDir();
    if (!existsSync(inbox)) return [];
    const entries = (await fs.readdir(inbox)).filter(
      (name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp"),
    );
    entries.sort();

    const messages: MailboxMessage[] = [];
    for (const name of entries) {
      const msg = parseMessage(JSON.parse(await fs.readFile(join(inbox, name), "utf-8")));
      if (!unreadOnly || !msg.read) messages.push(msg);
    }
    return messages;
  }

  /** 原位把消息标为已读（锁内 `.tmp` + rename）；收件箱不存在则 no-op。 */
  async markRead(messageId: string): Promise<void> {
    const inbox = this.getMailboxDir();
    if (!existsSync(inbox)) return;
    await exclusiveFileLock(this.lockPath(), async () => {
      const entries = (await fs.readdir(inbox)).filter(
        (name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(".tmp"),
      );
      for (const name of entries) {
        const path = join(inbox, name);
        const message = parseMessage(
          JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>,
        );
        if (message.id === messageId) {
          const updated: MailboxMessage = { ...message, read: true };
          const tmpPath = `${path}.tmp`;
          await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
          await fs.rename(tmpPath, path);
          return;
        }
      }
    });
  }

  /** 清空收件箱（保留目录与锁文件）；收件箱不存在则 no-op。 */
  async clear(): Promise<void> {
    const inbox = this.getMailboxDir();
    if (!existsSync(inbox)) return;
    await exclusiveFileLock(this.lockPath(), async () => {
      const entries = (await fs.readdir(inbox)).filter((name) => !name.startsWith("."));
      for (const name of entries) {
        await fs.unlink(join(inbox, name)).catch(() => {});
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

function makeMessage(
  type: MessageType,
  sender: string,
  recipient: string,
  payload: Record<string, unknown>,
): MailboxMessage {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type,
    sender,
    recipient,
    payload,
    timestamp: Date.now() / 1000,
    read: false,
  };
}

export function createUserMessage(sender: string, recipient: string, content: string): MailboxMessage {
  return makeMessage("user_message", sender, recipient, { content });
}

export function createShutdownRequest(sender: string, recipient: string): MailboxMessage {
  return makeMessage("shutdown", sender, recipient, {});
}

export function createIdleNotification(sender: string, recipient: string, summary: string): MailboxMessage {
  return makeMessage("idle_notification", sender, recipient, { summary });
}

/** worker→leader 的权限请求消息（payload 字段对齐 Python/TS teammateMailbox 形状）。 */
export function createPermissionRequestMessage(
  sender: string,
  recipient: string,
  requestData: Record<string, unknown>,
): MailboxMessage {
  return makeMessage("permission_request", sender, recipient, {
    type: "permission_request",
    request_id: requestData.request_id ?? "",
    agent_id: requestData.agent_id ?? sender,
    tool_name: requestData.tool_name ?? "",
    tool_use_id: requestData.tool_use_id ?? "",
    description: requestData.description ?? "",
    input: requestData.input ?? {},
    permission_suggestions: requestData.permission_suggestions ?? [],
  });
}

/** leader→worker 的权限响应消息；subtype=error 与 success 两种 payload 形状。 */
export function createPermissionResponseMessage(
  sender: string,
  recipient: string,
  responseData: Record<string, unknown>,
): MailboxMessage {
  const subtype = responseData.subtype ?? "success";
  if (subtype === "error") {
    return makeMessage("permission_response", sender, recipient, {
      type: "permission_response",
      request_id: responseData.request_id ?? "",
      subtype: "error",
      error: responseData.error ?? "Permission denied",
    });
  }
  return makeMessage("permission_response", sender, recipient, {
    type: "permission_response",
    request_id: responseData.request_id ?? "",
    subtype: "success",
    response: {
      updated_input: responseData.updated_input,
      permission_updates: responseData.permission_updates,
    },
  });
}

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

function guard(msg: MailboxMessage, type: MessageType): Record<string, unknown> | null {
  if (msg.type === type) return msg.payload;
  return null;
}

export function isPermissionRequest(msg: MailboxMessage): Record<string, unknown> | null {
  return guard(msg, "permission_request");
}

export function isPermissionResponse(msg: MailboxMessage): Record<string, unknown> | null {
  return guard(msg, "permission_response");
}

// ---------------------------------------------------------------------------
// 全局便捷函数
// ---------------------------------------------------------------------------

/**
 * 把 TeammateMessage 形状的 dict 写进收件人邮箱；从 text 嗅探消息类型以便路由。
 * team 缺省取 CLAUDE_CODE_TEAM_NAME，再缺省 "default"。
 */
export async function writeToMailbox(
  recipientName: string,
  message: Record<string, unknown>,
  teamName?: string,
): Promise<void> {
  const team = teamName ?? process.env.CLAUDE_CODE_TEAM_NAME ?? "default";
  const text = typeof message.text === "string" ? message.text : "";

  const msg: MailboxMessage = {
    schemaVersion: 1,
    id: randomUUID(),
    type: "user_message",
    sender: typeof message.from === "string" ? message.from : "unknown",
    recipient: recipientName,
    payload: {
      text,
      color: message.color,
      summary: message.summary,
      timestamp: message.timestamp,
    },
    timestamp: Date.now() / 1000,
    read: false,
  };
  await new TeammateMailbox(team, recipientName).write(msg);
}
