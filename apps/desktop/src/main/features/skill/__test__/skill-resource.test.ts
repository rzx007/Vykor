import { CURRENT_PROTOCOL_VERSION, HttpTransport, RuntimeResource } from "@rzx/client";
import { expect, it } from "vitest";
import { SkillResource } from "../skill-resource";

it("lists skills through the public runtime and removes an exact skill revision", async () => {
  const requests: Request[] = [];
  const snapshot = { skills: [], projects: [{ name: "App", path: "/repo" }], warnings: [] };
  const transport = new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    if (new URL(String(url)).pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    requests.push(new Request(url, init));
    return Response.json(snapshot);
  } });

  await expect(new RuntimeResource(transport).listSkills()).resolves.toEqual(snapshot);
  await expect(new SkillResource(transport).removeSkill("skill/a b", { expectedContent: "current" })).resolves.toEqual(snapshot);
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/skills"],
    ["DELETE", "/skills/skill%2Fa%20b"],
  ]);
  expect(await requests[1]!.json()).toEqual({ expectedContent: "current" });
});
