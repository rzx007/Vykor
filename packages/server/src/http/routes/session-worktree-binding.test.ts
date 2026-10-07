import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { SessionCommandService } from "../../application/session/session-command-service.js";
import { createSessionRoutes } from "./session.js";
it("keeps ordinary archive edits forbidden while clearing only a removed worktree binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-worktree-endpoint-"));
  const path = join(directory, "worktree");
  mkdirSync(path);
  const store = new SessionStore({ path: join(directory, "store.db") });
  const binding = { id: "worktree", path, branch: "vykor/task" };
  try {
    store.sessions.create({
      id: "session",
      cwd: path,
      model: "m",
      metadata: {
        desktop: { worktree: binding, settingsRoot: directory, retained: true },
        other: "retained",
      },
    });
    const commands = new SessionCommandService({
      sessions: {
        getSession: (id: string) => store.sessions.get(id),
        clearWorktreeBinding: (id: string, input: any) =>
          store.sessions.clearWorktreeBinding(id, input),
      } as any,
      transactions: {} as any,
      runtimeControl: {
        hasLiveChild: () => false,
        hasRunWork: () => false,
        hasActiveWorkForSession: () => false,
      } as any,
      operationGate: {
        tryEnterBarrier: (_target, predicate) =>
          predicate() ? { release() {} } : null,
      },
      events: {
        checkpoint: () =>
          store.conversations.listEvents({ sessionId: "session" }).length,
        publishSince() {},
      },
    });
    const routes = createSessionRoutes({
      commands,
      queries: {} as any,
      interactions: {} as any,
      traces: {} as any,
    });
    const post = (body: unknown = binding) =>
      routes.request("/session/worktree-cleared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post()).status).toBe(409);
    store.sessions.archive("session");
    expect((await post()).status).toBe(409);
    rmdirSync(path);
    expect((await post({ ...binding, id: "different" })).status).toBe(409);
    expect((await post({ ...binding, metadata: {} })).status).toBe(400);
    const response = await post();
    expect(response.status).toBe(200);
    const expected = {
      desktop: { settingsRoot: directory, retained: true },
      other: "retained",
    };
    expect((await response.json()).session.metadata).toEqual(expected);
    expect(store.sessions.get("session")!.metadata).toEqual(expected);
    expect((await post()).status).toBe(200);
    expect(
      (
        await routes.request("/session", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "forbidden" }),
        })
      ).status,
    ).toBe(409);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
