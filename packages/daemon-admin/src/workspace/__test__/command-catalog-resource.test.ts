import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import { expect, it } from "vitest";
import { CommandCatalogResource } from "../index.js";

it("lists daemon commands for the requested working directory", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const entry = { name: "/commit", kind: "template", skillName: "commit", path: "/skills/commit/SKILL.md", source: "user", description: "Commit" };
  const catalog = new CommandCatalogResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    expect(init?.signal).toBe(signal);
    calls.push(`${init?.method ?? "GET"} ${url.pathname + url.search}`);
    return Response.json({ commands: [entry] });
  } }));

  await expect(catalog.listCommands({ cwd: "/remote repo", signal })).resolves.toEqual([entry]);
  expect(calls).toEqual(["GET /commands?cwd=%2Fremote+repo"]);
});
