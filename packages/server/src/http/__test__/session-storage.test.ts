import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VykorClient } from "../../../../client/src/index.js";
import { VykorHttpServer } from "../server.js";

it("passes storage through the client and HTTP creation/fork routes without changing ordinary forks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oh-session-storage-http-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"));
  const server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), logger: () => {} });
  try {
    await server.application.ready();
    const client = new VykorClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => await server.app.request(String(input), init),
    });
    const source = await client.sessions.create({ cwd: directory, model: "test-model" });
    const message = server.store.conversations.createMessage({ sessionId: source.id, role: "user" });
    server.store.conversations.upsertMessagePart({ sessionId: source.id, messageId: message.id, type: "text", text: "source history" });

    const temporary = await client.sessions.fork(source.id, { storage: "memory", afterMessageId: message.id });
    expect(temporary).toMatchObject({ parentId: source.id, storage: "memory" });
    expect((await client.sessions.getState(temporary.id)).session.storage).toBe("memory");
    expect((await client.sessions.getState(temporary.id)).parts.map((part) => part.text)).toEqual(["source history"]);
    expect(server.store.conversations.listMessages(source.id).map((item) => item.id)).toEqual([message.id]);

    const blank = await client.sessions.fork(source.id, { storage: "memory", copyHistory: false });
    const blankState = await client.sessions.getState(blank.id);
    expect(blankState.session).toMatchObject({ parentId: source.id, storage: "memory", cwd: directory, model: "test-model" });
    for (const records of [blankState.messages, blankState.parts, blankState.inputs, blankState.runs, blankState.attempts, blankState.permissions]) {
      expect(records).toEqual([]);
    }
    await client.sessions.delete(blank.id);
    await expect(client.sessions.getState(blank.id)).rejects.toMatchObject({ status: 404 });
    expect((await client.sessions.getState(source.id)).parts.map((part) => part.text)).toEqual(["source history"]);

    const ordinaryFork = await client.sessions.fork(source.id);
    expect(ordinaryFork).not.toHaveProperty("storage");
    expect((await client.sessions.getState(ordinaryFork.id)).parts.map((part) => part.text)).toEqual(["source history"]);
    const directTemporary = await client.sessions.create({ cwd: directory, model: "test-model", storage: "memory" });
    expect(directTemporary.storage).toBe("memory");
    await expect(client.sessions.fork(source.id, { storage: "disk" } as any))
      .rejects.toMatchObject({ status: 400 });
    await expect(client.sessions.update(temporary.id, { storage: "sqlite" } as any))
      .rejects.toMatchObject({ status: 400 });
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
