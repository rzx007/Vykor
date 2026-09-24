import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type MailboxMessage,
  TeammateMailbox,
  getTeamDir,
  getAgentMailboxDir,
  createUserMessage,
  createShutdownRequest,
  createIdleNotification,
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  isPermissionRequest,
  isPermissionResponse,
  writeToMailbox,
} from "./mailbox.js";

// 测试写入真实 ~/.vykor/teams 下的唯一团队名，用后整目录清理
// （与 output-styles 用户样式测试同一套约定）。
let team: string;

beforeEach(() => {
  team = `__test_mb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  rmSync(join(homedir(), ".vykor", "teams", team), { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_TEAM_NAME;
});

function makeMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    schemaVersion: 1,
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 10)}`,
    type: overrides.type ?? "user_message",
    sender: overrides.sender ?? "alice",
    recipient: overrides.recipient ?? "bob",
    payload: overrides.payload ?? { content: "hi" },
    timestamp: overrides.timestamp ?? Date.now() / 1000,
    read: overrides.read ?? false,
  };
}

describe("directory helpers", () => {
  it("rejects path-traversal team and agent names", () => {
    expect(() => getTeamDir("../escape")).toThrow(/Unsafe/);
    expect(() => getTeamDir("a/b")).toThrow(/Unsafe/);
    expect(() => getTeamDir("a\\b")).toThrow(/Unsafe/);
    expect(() => getTeamDir("..")).toThrow(/Unsafe/);
    expect(() => getTeamDir("")).toThrow(/Unsafe/);
    expect(() => getAgentMailboxDir(team, "../../sneaky")).toThrow(/Unsafe/);
  });

  it("getTeamDir points at ~/.vykor/teams/<team> without creating it by default", () => {
    const dir = getTeamDir(team);
    expect(dir).toBe(join(homedir(), ".vykor", "teams", team));
    expect(existsSync(dir)).toBe(false);
  });

  it("getTeamDir with ensure:true creates the directory", () => {
    const dir = getTeamDir(team, { ensure: true });
    expect(existsSync(dir)).toBe(true);
  });

  it("getAgentMailboxDir nests agents/<id>/inbox under the team dir without creating it", () => {
    const dir = getAgentMailboxDir(team, "bob");
    expect(dir).toBe(join(getTeamDir(team), "agents", "bob", "inbox"));
    expect(existsSync(dir)).toBe(false);
  });

  it("getAgentMailboxDir with ensure:true creates the inbox", () => {
    const dir = getAgentMailboxDir(team, "bob", { ensure: true });
    expect(existsSync(dir)).toBe(true);
  });
});

describe("TeammateMailbox.write", () => {
  it("writes one JSON file per message named <timestamp>_<id>.json", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    const msg = makeMessage({ id: "msg-1", timestamp: 1234.5 });
    await mailbox.write(msg);

    const files = readdirSync(mailbox.getMailboxDir()).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(["1234.500000_msg-1.json"]);
    const data = JSON.parse(readFileSync(join(mailbox.getMailboxDir(), files[0]!), "utf-8"));
    expect(data).toEqual({
      schemaVersion: 1,
      id: "msg-1",
      type: "user_message",
      sender: "alice",
      recipient: "bob",
      payload: { content: "hi" },
      timestamp: 1234.5,
      read: false,
    });
  });

  it("leaves no .tmp residue after write", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    await mailbox.write(makeMessage());
    const leftovers = readdirSync(mailbox.getMailboxDir()).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("TeammateMailbox.readAll", () => {
  it("returns messages oldest-first", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    await mailbox.write(makeMessage({ id: "b", timestamp: 2 }));
    await mailbox.write(makeMessage({ id: "a", timestamp: 1 }));
    await mailbox.write(makeMessage({ id: "c", timestamp: 3 }));
    const messages = await mailbox.readAll();
    expect(messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("filters read messages by default but returns them with unreadOnly=false", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    await mailbox.write(makeMessage({ id: "seen", timestamp: 1, read: true }));
    await mailbox.write(makeMessage({ id: "new", timestamp: 2 }));
    expect((await mailbox.readAll()).map((m) => m.id)).toEqual(["new"]);
    expect((await mailbox.readAll(false)).map((m) => m.id)).toEqual(["seen", "new"]);
  });

  it("returns [] for a never-written mailbox without leaving an empty dir behind", async () => {
    const mailbox = new TeammateMailbox(team, "ghost");
    expect(await mailbox.readAll()).toEqual([]);
    expect(existsSync(join(homedir(), ".vykor", "teams", team))).toBe(false);
  });

  it("skips dotfiles and .tmp files but rejects corrupted messages", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    const inbox = mailbox.getMailboxDir();
    await mailbox.write(makeMessage({ id: "good", timestamp: 1 }));
    writeFileSync(join(inbox, ".write_lock"), "");
    writeFileSync(join(inbox, "2.000000_half.json.tmp"), "{");
    writeFileSync(join(inbox, "3.000000_bad.json"), "not json");
    await expect(mailbox.readAll()).rejects.toThrow();
  });
});

describe("TeammateMailbox.markRead / clear", () => {
  it("markRead flips read=true in place", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    await mailbox.write(makeMessage({ id: "m1", timestamp: 1 }));
    await mailbox.markRead("m1");
    expect(await mailbox.readAll()).toEqual([]);
    const all = await mailbox.readAll(false);
    expect(all).toHaveLength(1);
    expect(all[0]!.read).toBe(true);
  });

  it("markRead rejects an old message format", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    const inbox = mailbox.getMailboxDir();
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "1.000000_old.json"), JSON.stringify({ id: "old", read: false }));
    await expect(mailbox.markRead("old")).rejects.toThrow("schema version");
  });

  it("clear removes all message files but keeps the inbox dir", async () => {
    const mailbox = new TeammateMailbox(team, "bob");
    await mailbox.write(makeMessage({ id: "m1", timestamp: 1 }));
    await mailbox.write(makeMessage({ id: "m2", timestamp: 2 }));
    await mailbox.clear();
    expect(await mailbox.readAll(false)).toEqual([]);
    expect(existsSync(mailbox.getMailboxDir())).toBe(true);
  });

  it("markRead and clear are no-ops on a never-written mailbox and leave no dir", async () => {
    const mailbox = new TeammateMailbox(team, "ghost");
    await mailbox.markRead("nope");
    await mailbox.clear();
    expect(existsSync(join(homedir(), ".vykor", "teams", team))).toBe(false);
  });
});

describe("message factories", () => {
  it("createUserMessage wraps content with type user_message", () => {
    const msg = createUserMessage("alice", "bob", "hello");
    expect(msg.type).toBe("user_message");
    expect(msg.sender).toBe("alice");
    expect(msg.recipient).toBe("bob");
    expect(msg.payload).toEqual({ content: "hello" });
    expect(msg.read).toBe(false);
    expect(msg.id.length).toBeGreaterThan(0);
  });

  it("createShutdownRequest / createIdleNotification carry the right type and payload", () => {
    expect(createShutdownRequest("a", "b").type).toBe("shutdown");
    expect(createShutdownRequest("a", "b").payload).toEqual({});
    const idle = createIdleNotification("a", "b", "done exploring");
    expect(idle.type).toBe("idle_notification");
    expect(idle.payload).toEqual({ summary: "done exploring" });
  });

  it("createPermissionRequestMessage fills payload from requestData with defaults", () => {
    const msg = createPermissionRequestMessage("worker-1", "team-lead", {
      request_id: "perm-1",
      tool_name: "Edit",
      input: { file_path: "a.ts" },
    });
    expect(msg.type).toBe("permission_request");
    expect(msg.payload).toEqual({
      type: "permission_request",
      request_id: "perm-1",
      agent_id: "worker-1",
      tool_name: "Edit",
      tool_use_id: "",
      description: "",
      input: { file_path: "a.ts" },
      permission_suggestions: [],
    });
  });

  it("createPermissionResponseMessage emits error and success shapes", () => {
    const err = createPermissionResponseMessage("team-lead", "worker-1", {
      request_id: "perm-1",
      subtype: "error",
      error: "nope",
    });
    expect(err.payload).toEqual({
      type: "permission_response",
      request_id: "perm-1",
      subtype: "error",
      error: "nope",
    });

    const ok = createPermissionResponseMessage("team-lead", "worker-1", {
      request_id: "perm-2",
      subtype: "success",
      updated_input: { file_path: "b.ts" },
    });
    expect(ok.payload).toEqual({
      type: "permission_response",
      request_id: "perm-2",
      subtype: "success",
      response: { updated_input: { file_path: "b.ts" }, permission_updates: undefined },
    });
  });
});

describe("type guards", () => {
  it("isPermissionRequest matches typed messages and returns payload", () => {
    const msg = createPermissionRequestMessage("w", "l", { request_id: "p1" });
    expect(isPermissionRequest(msg)).toEqual(msg.payload);
    expect(isPermissionResponse(msg)).toBeNull();
  });

  it("does not reinterpret user text as a permission envelope", () => {
    const envelope = makeMessage({
      type: "user_message",
      payload: { text: JSON.stringify({ type: "permission_request", request_id: "p2" }) },
    });
    expect(isPermissionRequest(envelope)).toBeNull();
  });

  it("returns null for non-matching or unparseable text", () => {
    expect(isPermissionRequest(makeMessage({ payload: { text: "not json" } }))).toBeNull();
    expect(isPermissionResponse(makeMessage({ payload: {} }))).toBeNull();
  });
});

describe("writeToMailbox", () => {
  it("does not infer control message types from user text", async () => {
    await writeToMailbox(
      "bob",
      { from: "alice", text: JSON.stringify({ type: "shutdown" }) },
      team,
    );
    const messages = await new TeammateMailbox(team, "bob").readAll();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("user_message");
    expect(messages[0]!.sender).toBe("alice");
  });

  it("defaults to user_message for plain text and falls back to env team name", async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = team;
    await writeToMailbox("bob", { from: "alice", text: "plain words" });
    const messages = await new TeammateMailbox(team, "bob").readAll();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("user_message");
    expect(messages[0]!.payload.text).toBe("plain words");
  });
});
