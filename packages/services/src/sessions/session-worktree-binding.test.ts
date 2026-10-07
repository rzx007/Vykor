import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const filesystem = vi.hoisted(() => ({ deniedPath: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: string, options?: any) => {
      if (path === filesystem.deniedPath)
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return actual.lstatSync(path, options);
    },
  };
});
import { SessionStore } from "../session-runtime/store.js";
describe("archived session worktree binding", () => {
  it("only clears a matching deleted directory binding and persists other metadata and an update event", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-worktree-unbind-"));
    const path = join(directory, "worktree");
    mkdirSync(path);
    const storePath = join(directory, "sessions.db");
    let store = new SessionStore({ path: storePath });
    const binding = { id: "worktree-id", path, branch: "vykor/result" };
    try {
      const metadata = {
        desktop: {
          worktree: binding,
          settingsRoot: directory,
          retained: "yes",
        },
        runtime: { model: "m" },
        retainedRoot: true,
      };
      store.sessions.create({ id: "session", cwd: path, model: "m", metadata });
      expect(() =>
        store.sessions.clearWorktreeBinding("session", binding),
      ).toThrow();
      store.sessions.archive("session");
      expect(() =>
        store.sessions.update("session", { metadata: {} }),
      ).toThrow();
      expect(() =>
        store.sessions.clearWorktreeBinding("session", binding),
      ).toThrow();
      rmdirSync(path);
      expect(() =>
        store.sessions.clearWorktreeBinding("session", {
          ...binding,
          id: "wrong-id",
        }),
      ).toThrow();
      filesystem.deniedPath = path;
      expect(() =>
        store.sessions.clearWorktreeBinding("session", binding),
      ).toThrow();
      expect(store.sessions.get("session")?.metadata).toEqual(metadata);
      filesystem.deniedPath = "";
      const result = store.sessions.clearWorktreeBinding("session", binding);
      const expected = {
        desktop: { settingsRoot: directory, retained: "yes" },
        runtime: { model: "m" },
        retainedRoot: true,
      };
      expect(result.metadata).toEqual(expected);
      expect(result.status).toBe("archived");
      const events = store.conversations
        .listEvents({ sessionId: "session" })
        .filter((item) => item.type === "session.updated");
      expect(events.at(-1)?.payload).toMatchObject({
        session: { metadata: expected, status: "archived" },
      });
      expect(
        store.sessions.clearWorktreeBinding("session", binding).metadata,
      ).toEqual(expected);
      expect(
        store.conversations
          .listEvents({ sessionId: "session" })
          .filter((item) => item.type === "session.updated"),
      ).toHaveLength(events.length);
      store.close();
      store = new SessionStore({ path: storePath });
      expect(store.sessions.get("session")?.metadata).toEqual(expected);
    } finally {
      filesystem.deniedPath = "";
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
