import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import { expect, it } from "vitest";
import { WorktreeBindingResource } from "../worktree-binding-resource";

it("sends only the expected cleanup binding to the exact session and retains its metadata", async () => {
  const requests: Request[] = [];
  const metadata = { desktop: { settingsRoot: "/project", retained: true } };
  const session = {
    id: "session/one", cwd: "/tasks/worktree", title: "", model: "m",
    createdAt: 1, updatedAt: 2, metadata, status: "archived",
  };
  const resource = new WorktreeBindingResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    if (new URL(String(url)).pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    requests.push(new Request(url, init));
    return Response.json({ session });
  } }));
  const binding = { id: "worktree", path: "/tasks/worktree", branch: "vykor/task" };

  await expect(resource.clearWorktreeBinding(session.id, binding)).resolves.toMatchObject({ metadata });
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/sessions/session%2Fone/worktree-cleared"],
  ]);
  expect(await requests[0]!.json()).toEqual(binding);
});
