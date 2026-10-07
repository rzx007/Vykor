import { expect, it } from "vitest";
import { SessionResource } from "./session-resource.js";
import type { HttpTransport } from "../transport/http-transport.js";
it("sends only an expected cleanup binding to the exact session", async () => {
  const calls: Array<{ path: string; options: unknown }> = [];
  const metadata = { desktop: { settingsRoot: "/project", retained: true } };
  const resource = new SessionResource({
    request: async (path: string, options: unknown) => {
      calls.push({ path, options });
      return {
        session: {
          id: "session/one",
          cwd: "/tasks/worktree",
          title: "",
          model: "m",
          createdAt: 1,
          updatedAt: 2,
          metadata,
          status: "archived",
        },
      };
    },
  } as unknown as HttpTransport);
  const binding = {
    id: "worktree",
    path: "/tasks/worktree",
    branch: "vykor/task",
  };
  expect(
    (await resource.clearWorktreeBinding("session/one", binding)).metadata,
  ).toEqual(metadata);
  expect(calls).toEqual([
    {
      path: "/sessions/session%2Fone/worktree-cleared",
      options: { method: "POST", body: binding, signal: undefined },
    },
  ]);
});
