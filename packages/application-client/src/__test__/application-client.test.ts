import { describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { SessionResource, AttachmentResource, FilesResource } from "@rzx/client";
import { VykorClient } from "../index.js";

// Removing the private facade would stop product business requests at this boundary.
describe("private application client", () => {
  it("keeps read-only capability queries on runtime and product administration on private resources", () => {
    const client = new VykorClient({ baseUrl: "http://daemon.test" });
    expect("listSkills" in client.development).toBe(false);
    expect("listAgentPersonas" in client.development).toBe(false);
    expect("getSessionMcp" in client.system).toBe(false);
    expect("listModels" in client.providers).toBe(false);
    expect(client.development.removeSkill).toBeTypeOf("function");
    expect(client.providers.refreshModels).toBeTypeOf("function");
  });

  it("uses the shared runtime for model reads while preserving explicit product refresh", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const providers = [{ name: "test", displayName: "Test", models: [] }];
    const client = new VykorClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/capabilities") return Response.json({
        serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {},
      });
      expect(init?.signal).toBe(controller.signal);
      calls.push(url.pathname + url.search);
      return Response.json({ providers });
    } });
    await expect(client.runtime.listModels({ signal: controller.signal })).resolves.toEqual(providers);
    await expect(client.providers.refreshModels({ signal: controller.signal })).resolves.toEqual(providers);
    expect(calls).toEqual(["/models", "/models?refresh=true"]);
  });

  it("preserves application snapshot data while sharing lifecycle resources", async () => {
    const snapshot = {
      cursor: 1,
      session: { id: "s", cwd: "/repo", title: "Agent", model: "test", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 },
      inputs: [], messages: [], parts: [], runs: [], attempts: [], permissions: [],
      pluginApps: [{ id: "private-app" }],
    };
    const client = new VykorClient({ baseUrl: "http://daemon.test", fetch: async url => Response.json(
      String(url).endsWith("/capabilities") ? { serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} } : snapshot) });
    await expect(client.sessions.getState("s")).resolves.toEqual(snapshot);
  });

  it("provides a business facade without requests during construction", () => {
    let requests = 0;
    const client = new VykorClient({
      baseUrl: "http://daemon.test",
      fetch: async () => { requests++; return Response.json({}); },
    });
    expect(requests).toBe(0);
    expect(client.notes.create).toBeTypeOf("function");
    expect(client.sessions.admitPrompt).toBeTypeOf("function");
    expect(client.sessions).toBeInstanceOf(SessionResource);
    expect(client.attachments).toBeInstanceOf(AttachmentResource);
    expect(client.files).toBeInstanceOf(FilesResource);
  });

  it("sends business requests through the authenticated SDK transport", async () => {
    const calls: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = [];
    const note = { id: "note-1", content: "Hello", revision: 1, createdAt: 1, updatedAt: 1 };
    const client = new VykorClient({
      baseUrl: "http://daemon.test/",
      token: "secret",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("authorization") });
        if (path === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
        if (path === "/notes") return Response.json({ note });
        if (path === "/settings") return Response.json({ settings: { theme: "dark" } });
        throw new Error(`Unexpected request ${path}`);
      },
    });
    await expect(client.notes.create({ content: "Hello" })).resolves.toEqual(note);
    await expect(client.system.patchSettings({ theme: "dark" })).resolves.toEqual({ theme: "dark" });
    expect(calls).toEqual([
      { path: "/capabilities", method: "GET", body: undefined, authorization: null },
      { path: "/notes", method: "POST", body: { content: "Hello" }, authorization: "Bearer secret" },
      { path: "/settings", method: "PATCH", body: { theme: "dark" }, authorization: "Bearer secret" },
    ]);
  });
});
