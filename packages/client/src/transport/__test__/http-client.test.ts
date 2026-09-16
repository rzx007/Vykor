import { describe, expect, it, vi } from "vitest";

import { sessionEventSchemaVersion } from "@openharness/protocol";
import {
  normalizeDaemonBaseUrl,
  IncompatibleProtocolError,
  OpenHarnessClient,
  streamServerSentEvents,
} from "../http-client.js";
import { syncEvents } from "../../state/sync.js";
import type {
  SessionEventRecord,
  SessionRecord,
  SessionStateSnapshot,
} from "../../types/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function event(seq: number, type = "daemon.test"): SessionEventRecord {
  return {
    id: `e${seq}`,
    seq,
    type,
    schemaVersion: sessionEventSchemaVersion(type),
    payload: {},
    createdAt: seq,
  };
}

describe("OpenHarnessClient", () => {
  it("routes every resource and compatibility facade through the same endpoint", async () => {
    const cases: Array<{
      name: string;
      response: unknown;
      expectedPath: string;
      direct(client: OpenHarnessClient, signal: AbortSignal): Promise<unknown>;
      facade(client: OpenHarnessClient, signal: AbortSignal): Promise<unknown>;
    }> = [
      { name: "system", response: { settings: {} }, expectedPath: "/settings", direct: (c, signal) => c.system.getSettings({ signal }), facade: (c, signal) => c.getSettings({ signal }) },
      { name: "provider", response: { providers: [] }, expectedPath: "/providers", direct: (c, signal) => c.providers.listProviders({ signal }), facade: (c, signal) => c.listProviders({ signal }) },
      { name: "auth", response: { auth: { providers: [] } }, expectedPath: "/auth", direct: (c, signal) => c.auth.getStatus({ signal }), facade: (c, signal) => c.getAuthStatus({ signal }) },
      { name: "project", response: { projects: [] }, expectedPath: "/projects", direct: (c, signal) => c.projects.list({ signal }), facade: (c, signal) => c.listProjects({ signal }) },
      { name: "plugin", response: { plugins: [], warnings: [] }, expectedPath: "/plugins?cwd=%2Frepo", direct: (c, signal) => c.plugins.list({ cwd: "/repo", signal }), facade: (c, signal) => c.listPlugins({ cwd: "/repo", signal }) },
      { name: "development", response: { agents: [] }, expectedPath: "/agent-personas", direct: (c, signal) => c.development.listAgentPersonas({ signal }), facade: (c, signal) => c.listAgentPersonas({ signal }) },
      { name: "session", response: { sessions: [] }, expectedPath: "/sessions", direct: (c, signal) => c.sessions.list({ signal }), facade: (c, signal) => c.listSessions({ signal }) },
      { name: "attachment", response: { missingFiles: [], orphanFiles: [], pendingDeletes: [], referencedAssets: 0, storedFiles: 0 }, expectedPath: "/attachments/storage", direct: (c, signal) => c.attachments.scanStorage({ signal }), facade: (c, signal) => c.scanAttachmentStorage({ signal }) },
      { name: "permission", response: { requests: [] }, expectedPath: "/permissions", direct: (c, signal) => c.permissions.list({ signal }), facade: (c, signal) => c.listPermissions({ signal }) },
      { name: "schedule", response: { running: false }, expectedPath: "/schedules/status", direct: (c, signal) => c.schedules.getStatus({ signal }), facade: (c, signal) => c.getScheduledTaskStatus({ signal }) },
      { name: "job", response: { jobs: [] }, expectedPath: "/jobs?sessionId=s1", direct: (c, signal) => c.jobs.list({ sessionId: "s1", signal }), facade: (c, signal) => c.listJobs({ sessionId: "s1", signal }) },
      { name: "terminal", response: { terminals: [] }, expectedPath: "/terminals", direct: (c, signal) => c.terminals.list({ signal }), facade: (c, signal) => c.listTerminals({ signal }) },
      { name: "channel", response: { connectors: [] }, expectedPath: "/channels/status", direct: (c, signal) => c.channels.getStatus({ signal }), facade: (c, signal) => c.getChannelStatus({ signal }) },
      { name: "event", response: { events: [] }, expectedPath: "/events", direct: (c, signal) => c.events.list({ signal }), facade: (c, signal) => c.listEvents({ signal }) },
    ];

    for (const entry of cases) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const controller = new AbortController();
      const client = new OpenHarnessClient({
        baseUrl: "http://daemon.test",
        fetch: (async (url, init = {}) => {
          calls.push({ url: String(url), init });
          return jsonResponse(entry.response);
        }) as typeof fetch,
      });
      await entry.direct(client, controller.signal);
      await entry.facade(client, controller.signal);
      expect(calls, entry.name).toHaveLength(2);
      expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search), entry.name)
        .toEqual([entry.expectedPath, entry.expectedPath]);
      expect(calls.every((call) => (call.init.method ?? "GET") === "GET"), entry.name).toBe(true);
      expect(calls.every((call) => call.init.signal === controller.signal), entry.name).toBe(true);
    }
  });

  it("uses typed plugin archive endpoints and preserves structured failures", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenHarnessClient({
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
      (client as any).previewPluginArchive({
        cwd: "C:/workspace",
        archivePath: "C:/archive.zip",
      }),
    ).resolves.toMatchObject({
      archiveDigest: "a".repeat(64),
      requestedPermissions: ["process:spawn"],
      approvalRequired: true,
    });
    await expect(
      (client as any).installPluginArchive({
        cwd: "C:/workspace",
        archivePath: "C:/archive.zip",
        expectedArchiveDigest: "a".repeat(64),
        approvedPermissions: ["process:spawn"],
      }),
    ).rejects.toMatchObject({
      name: "OpenHarnessApiError",
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
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(snapshot);
      }) as typeof fetch,
    });

    await expect(client.listSkills()).resolves.toEqual(snapshot);
    await expect(
      client.removeSkill("skill/a b", { expectedContent: "current" }),
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
    const client = new OpenHarnessClient({
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

    await client.scanAttachmentStorage();
    await client.repairAttachmentStorage();
    await client.gcAttachmentStorage();

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

  it("uploads, reads, downloads and deletes attachments with raw bodies", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit & { duplex?: string };
    }> = [];
    const ready = {
      id: "att_test",
      displayName: "截图.png",
      mediaType: "image/png",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      status: "ready",
      createdAt: 1,
      updatedAt: 2,
    };
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/content")) {
        return new Response(Uint8Array.of(1, 2, 3));
      }
      return jsonResponse(
        init?.method === "DELETE"
          ? { ...ready, status: "deleted", deletedAt: 3 }
          : ready,
        init?.method === "POST" ? 201 : 200,
      );
    };
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });
    const body = new Blob([Uint8Array.of(1, 2, 3)]);

    await expect(
      client.uploadAttachment({
        displayName: "截图.png",
        mediaType: "image/png",
        body,
      }),
    ).resolves.toEqual(ready);
    await expect(client.getAttachment("att_test")).resolves.toEqual(ready);
    const downloaded = await client.downloadAttachment("att_test", {
      range: { start: 1, end: 2 },
    });
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    await expect(client.deleteAttachment("att_test")).resolves.toMatchObject({
      status: "deleted",
    });

    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "POST http://daemon.test/attachments",
      "GET http://daemon.test/attachments/att_test",
      "GET http://daemon.test/attachments/att_test/content",
      "DELETE http://daemon.test/attachments/att_test",
    ]);
    expect(calls[0]!.init.body).toBe(body);
    const uploadHeaders = new Headers(calls[0]!.init.headers);
    expect(uploadHeaders.get("authorization")).toBe("Bearer tok");
    expect(uploadHeaders.get("content-type")).toBe("image/png");
    expect(uploadHeaders.get("x-openharness-filename")).toBe(
      encodeURIComponent("截图.png"),
    );
    expect(uploadHeaders.has("content-length")).toBe(false);
    expect(new Headers(calls[2]!.init.headers).get("range")).toBe("bytes=1-2");
  });

  it("sets duplex only for ReadableStream attachment uploads", async () => {
    const calls: Array<RequestInit & { duplex?: string }> = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse({
          id: "att_stream",
          displayName: "stream.bin",
          mediaType: "application/octet-stream",
          sizeBytes: 0,
          sha256: "b".repeat(64),
          status: "ready",
          createdAt: 1,
          updatedAt: 1,
        });
      }) as typeof fetch,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await client.uploadAttachment({ displayName: "stream.bin", body: stream });

    expect(calls[0]!.body).toBe(stream);
    expect(calls[0]!.duplex).toBe("half");
  });

  it("validates attachment ranges before issuing a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: fetchImpl,
    });

    await expect(
      client.downloadAttachment("att_test", {
        range: { start: 0, suffixBytes: 2 },
      }),
    ).rejects.toThrow("suffixBytes");
    await expect(
      client.downloadAttachment("att_test", { range: { start: -1 } }),
    ).rejects.toThrow("start");
    await expect(
      client.downloadAttachment("att_test", { range: { start: 5, end: 2 } }),
    ).rejects.toThrow("end");
    await expect(
      client.downloadAttachment("att_test", { range: { end: 2 } }),
    ).rejects.toThrow("start");
    await expect(
      client.downloadAttachment("att_test", { range: { suffixBytes: 0 } }),
    ).rejects.toThrow("suffixBytes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds open-ended and suffix attachment ranges", async () => {
    const ranges: Array<string | null> = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (_url, init) => {
        ranges.push(new Headers(init?.headers).get("range"));
        return new Response(Uint8Array.of(1));
      }) as typeof fetch,
    });

    await client.downloadAttachment("att_test", { range: { start: 4 } });
    await client.downloadAttachment("att_test", {
      range: { suffixBytes: 3 },
    });

    expect(ranges).toEqual(["bytes=4-", "bytes=-3"]);
  });

  it("keeps attachment HTTP errors as OpenHarnessApiError", async () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async () =>
        jsonResponse(
          { error: "attachment_too_large: limit exceeded" },
          413,
        )) as typeof fetch,
    });

    await expect(
      client.uploadAttachment({
        displayName: "large.bin",
        body: new Blob([Uint8Array.of(1)]),
      }),
    ).rejects.toMatchObject({
      name: "OpenHarnessApiError",
      status: 413,
      body: { error: "attachment_too_large: limit exceeded" },
    });
  });

  it("does not expose the removed public Task CRUD methods", () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
    });

    expect(
      ["listTasks", "getTask", "stopTask", "createTask"].filter(
        (method) => method in client,
      ),
    ).toEqual([]);
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
    const client = new OpenHarnessClient({
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

    await expect(client.createCustomProvider(input)).resolves.toMatchObject({
      name: "office-gateway",
      custom: true,
    });
    await expect(
      client.connectCatalogProvider("remote", "catalog-secret"),
    ).resolves.toBeDefined();
    await expect(
      client.disconnectCatalogProvider("remote"),
    ).resolves.toBeUndefined();
    await expect(
      client.updateCustomProvider("office-gateway", {
        ...input,
        displayName: "Office AI",
      }),
    ).resolves.toMatchObject({ displayName: "Office AI" });
    await expect(
      client.removeCustomProvider("office-gateway"),
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
    const client = new OpenHarnessClient({
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

  it("normalizes safe daemon URLs and rejects URL-based credential leaks", () => {
    expect(normalizeDaemonBaseUrl(" https://daemon.example/api/ ")).toBe(
      "https://daemon.example/api",
    );
    expect(() => normalizeDaemonBaseUrl("ftp://daemon.example")).toThrow(
      "http or https",
    );
    expect(() =>
      normalizeDaemonBaseUrl("https://token@daemon.example"),
    ).toThrow("must not contain credentials");
    expect(() =>
      normalizeDaemonBaseUrl("https://daemon.example?token=secret"),
    ).toThrow("must not contain query");
    expect(() => normalizeDaemonBaseUrl("not-a-url")).toThrow(
      "absolute http or https",
    );
  });

  it("keeps protocol error messages from non-success responses", async () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: (async () =>
        jsonResponse(
          {
            code: "invalid_request",
            message: "delivery must be one of: queue, steer",
            details: { field: "delivery" },
          },
          400,
        )) as typeof fetch,
    });

    await expect(client.health()).rejects.toMatchObject({
      message: "delivery must be one of: queue, steer",
      status: 400,
      body: {
        code: "invalid_request",
        details: { field: "delivery" },
      },
    });
  });

  it("rejects malformed success data instead of trusting its TypeScript type", async () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: (async () =>
        jsonResponse({
          cursor: "latest",
          session: {},
          inputs: [],
          messages: [],
          parts: [],
          runs: [],
          permissions: [],
        })) as typeof fetch,
    });

    await expect(client.getSessionState("s1")).rejects.toMatchObject({
      code: "invalid_protocol_data",
      details: { path: "snapshot.cursor" },
    });
  });

  it("calls typed API endpoints with bearer auth and JSON bodies", async () => {
    const session: SessionRecord = {
      id: "s1",
      cwd: process.cwd(),
      title: "Main",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ session });
    };

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456/",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      client.createSession({
        id: "s1",
        cwd: process.cwd(),
        model: "m",
        title: "Main",
      }),
    ).resolves.toEqual(session);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3456/sessions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      id: "s1",
      model: "m",
    });
  });

  it("calls health without bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    };

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3456/health");
    expect(calls[0]!.init.headers).toEqual({});
  });

  it("loads capabilities without auth and rejects an incompatible server", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        serverVersion: "0.4.0",
        protocol: { version: 1 },
        features: { jobs: 1 },
      }),
    );
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "secret",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      client.capabilities({
        support: { version: 2 },
      }),
    ).rejects.toBeInstanceOf(IncompatibleProtocolError);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3456/capabilities",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("parses daemon-host execution environment capabilities", async () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: vi.fn(async () =>
        jsonResponse({
          serverVersion: "0.4.0",
          protocol: { version: 3 },
          features: {},
          agentEnvironments: { native: true, wsl: true },
        }),
      ) as typeof fetch,
    });

    await expect(client.capabilities()).resolves.toMatchObject({
      agentEnvironments: { native: true, wsl: true },
    });
  });

  it("rejects the previous protocol by default instead of silently hiding plugin inputs", async () => {
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: (async () => jsonResponse({ serverVersion: "old", protocol: { version: 2 }, features: {} })) as typeof fetch,
    });
    await expect(client.capabilities()).rejects.toBeInstanceOf(IncompatibleProtocolError);
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

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.listCommands({ cwd: "/repo" })).resolves.toEqual([
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
      client.updateSession("s1", {
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
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      client.createScheduledTask({
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
      client.listScheduledTasks({ status: "active" }),
    ).resolves.toEqual([task]);
    await expect(
      client.listScheduledRuns({ taskId: task.id, unread: true }),
    ).resolves.toEqual([]);
    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "POST http://127.0.0.1:3456/schedules/tasks",
      "GET http://127.0.0.1:3456/schedules/tasks?status=active",
      "GET http://127.0.0.1:3456/schedules/runs?taskId=schedule-1&unread=true",
    ]);
  });

  it("serializes the complete Jobs list query", async () => {
    const calls: string[] = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return jsonResponse({ jobs: [] });
      }) as typeof fetch,
    });

    await expect(
      client.listJobs({
        sessionId: "session-1",
        kinds: ["terminal", "agent"],
        statuses: ["running", "failed"],
        startedAfter: 10,
        limit: 5,
        includeFinished: false,
      }),
    ).resolves.toEqual([]);

    expect(calls).toEqual([
      "http://127.0.0.1:3456/jobs?sessionId=session-1&startedAfter=10&limit=5&kinds=terminal%2Cagent&statuses=running%2Cfailed&includeFinished=false",
    ]);
  });

  it("creates a producer-specific background shell", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const snapshot = {
      id: "task-1",
      kind: "shell" as const,
      label: "tests",
      ownerSession: "s1",
      status: "running" as const,
      capabilities: { read: true, wait: true, send: false, cancel: true },
      cwd: "/repo",
      startedAt: 1,
      updatedAt: 1,
    };
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ jobId: "task-1", snapshot });
      }) as typeof fetch,
    });

    await expect(
      client.createBackgroundShell({
        requestId: "request-1",
        sessionId: "s1",
        command: "pnpm test",
        description: "tests",
      }),
    ).resolves.toEqual({ jobId: "task-1", snapshot });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3456/background-shells");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        requestId: "request-1",
        sessionId: "s1",
        command: "pnpm test",
        description: "tests",
      }),
    });
  });

  it("replays an interrupted run through the dedicated, idempotent endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(
        {
          input: {
            id: "recovery-i1",
            sessionId: "s1",
            seq: 2,
            delivery: "queue",
            content: "retry",
            metadata: {},
            createdAt: 2,
          },
          run: {
            id: "recovery-r1",
            sessionId: "s1",
            inputId: "recovery-i1",
            status: "pending",
            metadata: {},
            createdAt: 2,
            updatedAt: 2,
          },
          source_run: {
            id: "r1",
            sessionId: "s1",
            inputId: "i1",
            status: "interrupted",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        },
        202,
      );
    };
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      client.resumeInterruptedRun("s1", "r1", { id: "request-1" }),
    ).resolves.toMatchObject({
      run: { id: "recovery-r1" },
      source_run: { id: "r1", status: "interrupted" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3456/sessions/s1/runs/r1/resume",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      id: "request-1",
    });
  });

  it("parses server-sent event frames and ignores comments", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": connected\n\n"));
        controller.enqueue(
          encoder.encode(
            `id: 1\nevent: session.created\ndata: ${JSON.stringify(event(1))}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `id: 2\nevent: session.run.updated\ndata: ${JSON.stringify(event(2))}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const events: SessionEventRecord[] = [];
    for await (const parsed of streamServerSentEvents(async () => stream))
      events.push(parsed);

    expect(events.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("reconnects SSE with the latest frame id and server retry delay", async () => {
    vi.useFakeTimers();
    const headers: Array<string | null> = [];
    const urls: string[] = [];
    let attempt = 0;
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async (url, init) => {
        urls.push(String(url));
        headers.push(new Headers(init?.headers).get("last-event-id"));
        attempt += 1;
        // Mirror the server's cursor precedence: query cursor wins over Last-Event-ID.
        const queryCursor = new URL(String(url)).searchParams.get("cursor");
        const effectiveCursor = queryCursor ?? headers.at(-1);
        const body = attempt === 1
          ? `id: 7\nretry: 0\ndata: ${JSON.stringify(event(7))}\n\n`
          : `id: ${Number(effectiveCursor) + 1}\ndata: ${JSON.stringify(event(Number(effectiveCursor) + 1))}\n\n`;
        return new Response(body, { status: 200 });
      }) as typeof fetch,
    });

    const received: SessionEventRecord[] = [];
    const run = (async () => {
      for await (const item of client.events.stream({ cursor: 6, transportReconnect: true })) {
        received.push(item);
        if (received.length === 2) break;
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await run;

    expect(received.map((item) => item.seq)).toEqual([7, 8]);
    expect(headers).toEqual([null, "7"]);
    expect(urls).toEqual([
      "http://daemon.test/events/stream?cursor=6",
      "http://daemon.test/events/stream",
    ]);
    vi.useRealTimers();
  });

  it("keeps the legacy event facade finite when the server closes the stream", async () => {
    let calls = 0;
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: (async () => {
        calls += 1;
        return new Response(`id: 1\ndata: ${JSON.stringify(event(1))}\n\n`);
      }) as typeof fetch,
    });

    const received: SessionEventRecord[] = [];
    for await (const item of client.streamEvents({ cursor: 0 })) received.push(item);

    expect(received.map((item) => item.seq)).toEqual([1]);
    expect(calls).toBe(1);
  });

  it("merges replayed and live events while suppressing live duplicates", async () => {
    const controller = new AbortController();
    const stream = async function* (): AsyncIterable<SessionEventRecord> {
      yield event(2, "session.created");
      yield event(3, "session.input.admitted");
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    };
    const client = {
      sessions: {},
      events: {
        list: async () => [event(1, "session.created"), event(2, "session.message.created")],
        stream: () => stream(),
      },
    } as unknown as OpenHarnessClient;

    const updates: Array<{ seq: number; source: string; lastSeq: number }> = [];
    for await (const update of syncEvents(client, {
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      if (!update.event) continue;
      updates.push({
        seq: update.event.seq,
        source: update.source,
        lastSeq: update.state.lastSeq,
      });
    }

    expect(updates).toEqual([
      { seq: 1, source: "replay", lastSeq: 1 },
      { seq: 2, source: "replay", lastSeq: 2 },
      { seq: 3, source: "live", lastSeq: 3 },
    ]);
  });

  it("reconnects a disconnected live stream from lastSeq cursor", async () => {
    const controller = new AbortController();
    const cursors: Array<number | undefined> = [];
    let attempt = 0;
    const client = {
      sessions: {},
      events: {
        list: async () => [event(1, "session.created")],
        stream: (options: { cursor?: number }) => {
        cursors.push(options.cursor);
        attempt += 1;
        if (attempt === 1) {
          return (async function* () {
            yield event(2, "session.message.created");
            throw new Error("stream reset");
          })();
        }
        return (async function* () {
          yield event(3, "session.input.admitted");
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })();
        },
      },
    } as unknown as OpenHarnessClient;

    const liveSeqs: number[] = [];
    for await (const update of syncEvents(client, {
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      if (update.source === "live" && update.event)
        liveSeqs.push(update.event.seq);
    }

    expect(cursors).toEqual([1, 2]);
    expect(liveSeqs).toEqual([2, 3]);
  });

  it("does not reconnect after abort", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const client = {
      sessions: {},
      events: {
        list: async () => [event(1, "session.created")],
        stream: () => {
        streamCalls += 1;
        return (async function* () {
          yield event(2, "session.message.created");
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        })();
        },
      },
    } as unknown as OpenHarnessClient;

    const liveSeqs: number[] = [];
    for await (const update of syncEvents(client, {
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      if (update.source === "live" && update.event)
        liveSeqs.push(update.event.seq);
    }

    expect(streamCalls).toBe(1);
    expect(liveSeqs).toEqual([2]);
  });

  it("accepts global seq gaps in a session-filtered stream without re-snapshotting", async () => {
    const controller = new AbortController();
    const session: SessionRecord = {
      id: "s1",
      cwd: "/repo",
      title: "Main",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const snapshot = (cursor: number): SessionStateSnapshot => ({
      cursor,
      session,
      inputs: [],
      messages: [],
      parts: [],
      runs: [],
      permissions: [],
    });
    let streamAttempt = 0;
    let snapshotCalls = 0;
    const client = {
      sessions: {
        getState: async () => {
          snapshotCalls += 1;
          return snapshot(snapshotCalls === 1 ? 1 : 4);
        },
      },
      events: {
        list: async () => [],
        stream: (options: { cursor?: number }) => {
          streamAttempt += 1;
          if (streamAttempt === 1) {
            expect(options.cursor).toBe(1);
            return (async function* () {
              yield event(2, "session.message.created");
              throw new Error("stream reset");
            })();
          }
          expect(options.cursor).toBe(2);
          return (async function* () {
            yield event(5, "session.run.updated");
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
          })();
        },
      },
    } as unknown as OpenHarnessClient;

    const sources: string[] = [];
    let lastSeq = 0;
    for await (const update of syncEvents(client, {
      sessionId: "s1",
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source);
      lastSeq = update.state.lastSeq;
    }

    expect(snapshotCalls).toBe(1);
    expect(sources).toContain("reconnecting");
    expect(sources.filter((source) => source === "snapshot")).toHaveLength(1);
    expect(lastSeq).toBe(5);
  });

  it("adds a stable request id when admitting a prompt", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse(
          {
            input: {
              id: "server-input",
              sessionId: "s1",
              seq: 1,
              delivery: "queue",
              content: "hello",
              metadata: {},
              createdAt: 1,
            },
          },
          202,
        );
      },
    });

    const attachments = [
      { assetId: "att-b", intent: "auto" as const },
      { assetId: "att-a", intent: "ocr" as const, displayName: "receipt.png" },
    ];
    await client.admitPrompt("s1", { content: "hello", attachments });
    await client.editLatestPrompt("s1", {
      id: "edit-1",
      content: "replacement",
      sourceMessageId: "message-1",
      attachments,
    });
    const body = JSON.parse(String(calls[0]!.body)) as {
      id?: string;
      content: string;
      attachments: unknown[];
    };
    expect(body.content).toBe("hello");
    expect(body.id).toEqual(expect.any(String));
    expect(body.attachments).toEqual(attachments);
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({
      id: "edit-1",
      content: "replacement",
      sourceMessageId: "message-1",
      attachments,
    });
  });

  it("targets one durable queued prompt for promotion and cancellation", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ ok: true });
      },
    });

    await client.promoteQueuedPrompt("s1", "input 1", {
      queuedRunId: "queued-run",
      expectedActiveRunId: "active-run",
    });
    await client.cancelQueuedPrompt("s1", "input 2", {
      queuedRunId: "other-run",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://daemon.test/sessions/s1/prompts/input%201/promote",
      "http://daemon.test/sessions/s1/prompts/input%202/cancel",
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      queuedRunId: "queued-run",
      expectedActiveRunId: "active-run",
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      queuedRunId: "other-run",
    });
  });

  it("uses exponential reconnect delay until the stream recovers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delays: number[] = [];
    let attempt = 0;
    const client = {
      sessions: {},
      events: {
        list: async () => [],
        stream: () => {
        attempt += 1;
        if (attempt < 3) {
          return (async function* () {
            throw new Error(`boom-${attempt}`);
          })();
        }
        return (async function* () {
          yield event(1, "session.created");
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })();
        },
      },
    } as unknown as OpenHarnessClient;

    const run = (async () => {
      for await (const update of syncEvents(client, {
        signal: controller.signal,
        reconnectDelayMs: (n) => {
          const ms = 100 * 2 ** n;
          delays.push(ms);
          return ms;
        },
      })) {
        if (update.source === "live") break;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    expect(delays).toEqual([100]);
    await vi.advanceTimersByTimeAsync(100);
    expect(delays).toEqual([100, 200]);
    await vi.advanceTimersByTimeAsync(200);
    await run;
    vi.useRealTimers();
  });
});
