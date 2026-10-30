import { describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { VykorClient } from "../index.js";
function jsonResponse(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function businessClient(options: ConstructorParameters<typeof VykorClient>[0]): VykorClient {
  const endpointFetch = options.fetch!;
  return new VykorClient({ ...options, fetch: (input, init) => new URL(String(input)).pathname === "/capabilities" ? Promise.resolve(jsonResponse({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} })) : endpointFetch(input, init) });
}
describe("application business HTTP facade", () => {
it("uses typed plugin archive endpoints and preserves structured failures", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = businessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/preview"))
          return jsonResponse({
            archiveDigest: "a".repeat(64),
            identity: {
              id: "dev.example.archive",
              name: "archive",
              version: "1",
            },
            requestedPermissions: ["process:spawn"],
            approvalRequired: true,
            inventory: { tools: 1 },
            diagnostics: [],
          });
        return jsonResponse(
          {
            code: "plugin_archive_changed",
            message: "Select the archive again",
            diagnostics: [{ code: "archive_changed" }],
          },
          409,
        );
      }) as typeof fetch,
    });

    await expect(
      client.plugins.previewArchive({
        cwd: "C:/workspace",
        archivePath: "C:/archive.zip",
      }),
    ).resolves.toMatchObject({
      archiveDigest: "a".repeat(64),
      requestedPermissions: ["process:spawn"],
      approvalRequired: true,
    });
    await expect(
      client.plugins.installArchive({
        cwd: "C:/workspace",
        archivePath: "C:/archive.zip",
        expectedArchiveDigest: "a".repeat(64),
        approvedPermissions: ["process:spawn"],
      }),
    ).rejects.toMatchObject({
      name: "VykorApiError",
      status: 409,
      body: {
        code: "plugin_archive_changed",
        message: "Select the archive again",
        diagnostics: [{ code: "archive_changed" }],
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://daemon.test/plugins/archive/preview",
      "http://daemon.test/plugins/archive/install",
    ]);
  });

it("lists and removes skills through daemon resource routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const snapshot = {
      skills: [],
      projects: [{ name: "App", path: "/repo" }],
      warnings: [],
    };
    const client = businessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(snapshot);
      }) as typeof fetch,
    });

    await expect(client.runtime.listSkills()).resolves.toEqual(snapshot);
    await expect(
      client.development.removeSkill("skill/a b", { expectedContent: "current" }),
    ).resolves.toEqual(snapshot);

    expect(
      calls.map(({ url, init }) => `${init.method ?? "GET"} ${url}`),
    ).toEqual([
      "GET http://daemon.test/skills",
      "DELETE http://daemon.test/skills/skill%2Fa%20b",
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      expectedContent: "current",
    });
  });

it("scans, repairs, and garbage-collects attachment storage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = businessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const action = init.body
          ? JSON.parse(String(init.body)).action
          : undefined;
        return jsonResponse(
          action === "gc"
            ? {
                scannedAssets: 0,
                expiredLeases: 0,
                deletedAssets: 0,
                deletedBlobs: 0,
                releasedBytes: 0,
                skipped: {},
                errors: [],
              }
            : action === "repair-safe"
              ? { expiredLeases: 0, deletedOrphanBlobs: 0, releasedBytes: 0 }
              : {
                  summary: {
                    assets: { importing: 0, ready: 0, failed: 0, deleted: 0 },
                  },
                  issues: [],
                },
        );
      }) as typeof fetch,
    });

    await client.attachments.scanStorage();
    await client.attachments.repairStorage();
    await client.attachments.gcStorage();

    expect(
      calls.map(({ url, init }) => `${init.method ?? "GET"} ${url}`),
    ).toEqual([
      "GET http://daemon.test/attachments/storage",
      "POST http://daemon.test/attachments/storage/actions",
      "POST http://daemon.test/attachments/storage/actions",
    ]);
    expect(
      calls.slice(1).map(({ init }) => JSON.parse(String(init.body))),
    ).toEqual([{ action: "repair-safe" }, { action: "gc" }]);
  });

it("calls custom provider resource endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
      const body = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          provider: {
            name: body.id ?? "office-gateway",
            displayName: body.displayName,
            hasKey: Boolean(body.apiKey),
            active: false,
            custom: true,
          },
        },
        init?.method === "POST" ? 201 : 200,
      );
    };
    const client = businessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });
    const input = {
      id: "office-gateway",
      displayName: "Office Gateway",
      baseUrl: "https://gateway.example/v1",
      apiFormat: "openai" as const,
      apiKey: "secret",
      models: [{ id: "team-model", displayName: "Team Model" }],
    };

    await expect(client.providers.createCustomProvider(input)).resolves.toMatchObject({
      name: "office-gateway",
      custom: true,
    });
    await expect(
      client.providers.connectCatalogProvider("remote", "catalog-secret"),
    ).resolves.toBeDefined();
    await expect(
      client.providers.disconnectCatalogProvider("remote"),
    ).resolves.toBeUndefined();
    await expect(
      client.providers.updateCustomProvider("office-gateway", {
        ...input,
        displayName: "Office AI",
      }),
    ).resolves.toMatchObject({ displayName: "Office AI" });
    await expect(
      client.providers.removeCustomProvider("office-gateway"),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["http://127.0.0.1:3456/providers/custom", "POST"],
      ["http://127.0.0.1:3456/providers/catalog/remote/connect", "POST"],
      ["http://127.0.0.1:3456/providers/catalog/remote/connect", "DELETE"],
      ["http://127.0.0.1:3456/providers/custom/office-gateway", "PATCH"],
      ["http://127.0.0.1:3456/providers/custom/office-gateway", "DELETE"],
    ]);
  });

it("connects catalog providers with optional headers and patches header templates", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const client = businessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init = {}) => {
        const parsed = new URL(String(url));
        calls.push({
          path: parsed.pathname,
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({
          provider: {
            name: "remote",
            displayName: "Remote",
            hasKey: true,
            active: true,
          },
        });
      }) as typeof fetch,
    });

    await client.providers.connectCatalogProvider("remote", {
      apiKey: "catalog-secret",
      headers: { "X-Session": "{{sessionId}}" },
    });
    await client.providers.updateCatalogProviderHeaders("remote", {
      "User-Agent": "{{userAgent}}",
    });

    expect(calls).toEqual([
      {
        path: "/providers/catalog/remote/connect",
        method: "POST",
        body: {
          apiKey: "catalog-secret",
          headers: { "X-Session": "{{sessionId}}" },
        },
      },
      {
        path: "/providers/catalog/remote",
        method: "PATCH",
        body: { headers: { "User-Agent": "{{userAgent}}" } },
      },
    ]);
  });

it("lists commands without a command execution endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (
        String(url).includes("/commands") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse({
          commands: [
            {
              name: "/commit",
              kind: "template",
              skillName: "commit",
              path: "/skills/commit/SKILL.md",
              source: "user",
              description: "Commit",
            },
          ],
        });
      }
      if (String(url).includes("/sessions/s1") && init?.method === "PATCH") {
        return jsonResponse({
          session: {
            id: "s1",
            cwd: process.cwd(),
            title: "Main",
            model: "new-model",
            status: "idle",
            metadata: { runtime: { model: "new-model" } },
            createdAt: 1,
            updatedAt: 2,
          },
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    };

    const client = businessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.system.listCommands({ cwd: "/repo" })).resolves.toEqual([
      {
        name: "/commit",
        kind: "template",
        skillName: "commit",
        path: "/skills/commit/SKILL.md",
        source: "user",
        description: "Commit",
      },
    ]);
    await expect(
      client.sessions.update("s1", {
        metadata: { runtime: { model: "new-model" } },
      }),
    ).resolves.toMatchObject({ model: "new-model" });
    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "GET http://127.0.0.1:3456/commands?cwd=%2Frepo",
      "PATCH http://127.0.0.1:3456/sessions/s1",
    ]);
  });

it("uses the Agent Scheduled task endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const task = {
      id: "schedule-1",
      name: "review",
      prompt: "Review changes",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once" as const,
      timezone: "UTC",
      status: "active" as const,
      destination: "chat" as const,
      sessionId: "s1",
      projectPaths: [],
      executionMode: "local" as const,
      skillNames: [],
      pluginNames: [],
      permissionProfile: { mode: "workspace_write" as const },
      overlapPolicy: "skip" as const,
      missedRunPolicy: "skip" as const,
      createdBy: "agent" as const,
      runCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (init?.method === "POST") return jsonResponse({ task });
      if (String(url).includes("/runs")) return jsonResponse({ runs: [] });
      return jsonResponse({ tasks: [task] });
    };
    const client = businessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      client.schedules.createTask({
        name: task.name,
        prompt: task.prompt,
        recurrence: task.recurrence,
        recurrenceFormat: task.recurrenceFormat,
        timezone: task.timezone,
        destination: task.destination,
        sessionId: task.sessionId,
      }),
    ).resolves.toEqual(task);
    await expect(
      client.schedules.listTasks({ status: "active" }),
    ).resolves.toEqual([task]);
    await expect(
      client.schedules.listRuns({ taskId: task.id, unread: true }),
    ).resolves.toEqual([]);
    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "POST http://127.0.0.1:3456/schedules/tasks",
      "GET http://127.0.0.1:3456/schedules/tasks?status=active",
      "GET http://127.0.0.1:3456/schedules/runs?taskId=schedule-1&unread=true",
    ]);
  });

it("uses the global note endpoints and preserves note payloads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const note = { id: "n1", content: "idea", revision: 1, createdAt: 1, updatedAt: 1 };
    const client = businessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: (async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (init.method === "GET" || init.method === undefined) return jsonResponse({ notes: [note] });
        if (init.method === "DELETE") return jsonResponse({ removed: true });
        return jsonResponse({ note });
      }) as typeof fetch,
    });
    const notes = Reflect.get(client, "notes") as
      | {
          list(): Promise<(typeof note)[]>;
          create(input: { content: string }): Promise<typeof note>;
          update(
            id: string,
            input: { content: string; expectedRevision: number },
          ): Promise<typeof note>;
          remove(id: string): Promise<void>;
        }
      | undefined;
    expect(notes).toBeDefined();

    await expect(notes!.list()).resolves.toEqual([note]);
    await expect(notes!.create({ content: "idea" })).resolves.toEqual(note);
    await expect(
      notes!.update("n1", { content: "changed", expectedRevision: 1 }),
    ).resolves.toEqual(note);
    await expect(notes!.remove("n1")).resolves.toBeUndefined();

    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "GET http://127.0.0.1:3456/notes",
      "POST http://127.0.0.1:3456/notes",
      "PATCH http://127.0.0.1:3456/notes/n1",
      "DELETE http://127.0.0.1:3456/notes/n1",
    ]);
    expect(calls[1]?.init.body).toBe(JSON.stringify({ content: "idea" }));
    expect(calls[2]?.init.body).toBe(
      JSON.stringify({ content: "changed", expectedRevision: 1 }),
    );
  });
});
