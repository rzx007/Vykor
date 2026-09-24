import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { getDataDir } from "@vykor/core";
import { estimateTokens } from "./token-estimation/index.js";

/**
 * 文件型会话记忆 checkpoint。
 *
 * compact 连续性的确定性底座：每次更新把 task_focus 状态 + 最近消息摘要写成
 * `<dataDir>/session-memory/<项目名>-<sha1(cwd)前12>/<sessionId>.md`，
 * compact 边界经 sessionMemoryToCompactText 注回上下文。
 */

export const MAX_SESSION_MEMORY_CHARS = 12_000;
export const MAX_RECENT_LINES = 80;

/** 宽松消息形状（与 personalization 同思路：兼容引擎 Message 联合）。 */
export interface CheckpointMessageLike {
  role?: string;
  content: string | ReadonlyArray<unknown>;
}

export interface SessionMemoryOptions {
  toolMetadata?: Record<string, unknown>;
  sessionId?: string;
}

export function getSessionMemoryDir(cwd: string): string {
  const root = resolve(cwd);
  const digest = createHash("sha1").update(root).digest("hex").slice(0, 12);
  const dir = join(getDataDir(), "session-memory", `${basename(root)}-${digest}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionMemoryPath(cwd: string, sessionId?: string): string {
  const safe = (sessionId ?? "default").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(getSessionMemoryDir(cwd), `${safe}.md`);
}

/** 把 checkpoint 路径写进 toolMetadata，供 compact 链路找到它。 */
export function prepareSessionMemoryMetadata(
  cwd: string,
  toolMetadata: Record<string, unknown>,
  sessionId?: string,
): string {
  const sid = sessionId ?? String(toolMetadata.session_id ?? "default");
  const path = getSessionMemoryPath(cwd, sid);
  toolMetadata.session_memory_path = path;
  return path;
}

export function getSessionMemoryContent(path: string | undefined | null): string {
  if (!path) return "";
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** 更新确定性 checkpoint（`.tmp` + rename 原子写）。 */
export function updateSessionMemoryFile(
  cwd: string,
  messages: CheckpointMessageLike[],
  options?: SessionMemoryOptions,
): string {
  const toolMetadata = options?.toolMetadata ?? {};
  const path = prepareSessionMemoryMetadata(cwd, toolMetadata, options?.sessionId);
  const body = buildSessionMemoryDocument(messages, { toolMetadata });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
  return path;
}

/** 由 task_focus 状态 + 最近消息摘要构成的紧凑 Markdown checkpoint。 */
export function buildSessionMemoryDocument(
  messages: CheckpointMessageLike[],
  options?: { toolMetadata?: Record<string, unknown> },
): string {
  const state = options?.toolMetadata?.task_focus_state;
  let goal = "";
  let nextStep = "";
  let verified: string[] = [];
  let artifacts: string[] = [];
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as Record<string, unknown>;
    goal = String(s.goal ?? "").trim();
    nextStep = String(s.next_step ?? "").trim();
    verified = toTrimmedList(s.verified_state);
    artifacts = toTrimmedList(s.active_artifacts);
  }

  const lines = ["# Session Memory", ""];
  lines.push("## Current State", goal || "(no current goal recorded)", "");
  if (nextStep) lines.push("## Next Step", nextStep, "");
  if (verified.length > 0) lines.push("## Verified Work", ...verified.slice(-10).map((v) => `- ${v}`), "");
  if (artifacts.length > 0) lines.push("## Active Artifacts", ...artifacts.slice(-10).map((a) => `- ${a}`), "");
  const recent = recentMessageLines(messages);
  const render = () => [...lines, "## Recent Conversation", ...recent, ""].join("\n").trim() + "\n";
  let text = render();
  let truncated = false;
  while (text.length > MAX_SESSION_MEMORY_CHARS && recent.length > 1) {
    recent.shift();
    text = render();
    truncated = true;
  }
  if (text.length > MAX_SESSION_MEMORY_CHARS) {
    text = text.slice(0, MAX_SESSION_MEMORY_CHARS);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) text = text.slice(0, lastNewline);
    truncated = true;
  }
  if (truncated) text += "\n> Session memory was truncated to stay within budget.\n";
  return text;
}

/** compact 边界注入用的包装文本（超 4k token 再截一刀）。 */
export function sessionMemoryToCompactText(content: string): string {
  const stripped = content.trim();
  if (!stripped) return "";
  let body = stripped;
  if (estimateTokens(body).tokens > 4_000) {
    body = body.slice(0, MAX_SESSION_MEMORY_CHARS);
    const lastNewline = body.lastIndexOf("\n");
    if (lastNewline > 0) body = body.slice(0, lastNewline);
  }
  return "Session memory checkpoint from earlier in this conversation:\n" + body;
}

// ---------------------------------------------------------------------------
// 消息摘要
// ---------------------------------------------------------------------------

function toTrimmedList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function recentMessageLines(messages: CheckpointMessageLike[]): string[] {
  const lines: string[] = [];
  for (const message of messages.slice(-MAX_RECENT_LINES)) {
    const line = summarizeMessage(message);
    if (line) lines.push(`- ${line}`);
  }
  return lines.length > 0 ? lines : ["- (no recent messages)"];
}

function summarizeMessage(message: CheckpointMessageLike): string {
  const role = message.role ?? "system";

  // 文本：string content 或 blocks 里的 text 拼接。
  let text = "";
  const toolUseNames: string[] = [];
  let hasToolResult = false;
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const b = block as { type?: unknown; text?: unknown; name?: unknown } | null;
      if (typeof b?.text === "string") text += (text ? " " : "") + b.text;
      if (b?.type === "tool_use" && typeof b.name === "string") toolUseNames.push(b.name);
      if (b?.type === "tool_result") hasToolResult = true;
    }
  }

  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed) return `${role}: ${collapsed.slice(0, 220)}`;
  if (toolUseNames.length > 0) return `${role}: tool calls -> ${toolUseNames.slice(0, 6).join(", ")}`;
  if (hasToolResult) return `${role}: tool results returned`;
  return `${role}: [non-text content]`;
}
