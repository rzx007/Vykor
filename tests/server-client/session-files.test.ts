import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Settings } from "@vykor/host-config";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { VykorClient } from "@rzx/client";
import { VykorHttpServer } from "../../packages/server/src/http/server.js";

describe("session files through the real daemon and public SDK", () => {
  let directory: string;
  let projectRoot: string;
  let worktreeRoot: string;
  let server: VykorHttpServer | undefined;
  let client: VykorClient;
  let url: string;
  let rootSessionId: string;
  let childSessionId: string;
  let initialEventSequence: number;
  const createAgent = vi.fn(async () => { throw new Error("File browsing must not initialize an Agent"); });
  const getSettingsForCwd = vi.fn(async (_cwd: string): Promise<Settings> => ({
    model: "test-model", apiFormat: "openai", maxTurns: 1,
    permission: { mode: "default" }, agentEnvironment: { kind: "native" },
    sandbox: { enabled: false, filesystem: { denyRead: ["private"] } },
  } as Settings));
  const headers = { authorization: "Bearer files-test-token", [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "oh-session-files-http-"));
    projectRoot = join(directory, "project");
    worktreeRoot = join(directory, "worktree");
    vi.stubEnv("VYKOR_CONFIG_DIR", join(directory, "config"));
    vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");
    await mkdir(projectRoot);
    await mkdir(join(worktreeRoot, "src"), { recursive: true });
    await mkdir(join(worktreeRoot, "private"));
    await writeFile(join(projectRoot, "note.txt"), "project only\nneedle project", "utf8");
    await writeFile(join(worktreeRoot, "note.txt"), "worktree only\nNEEDLE task", "utf8");
    await writeFile(join(worktreeRoot, "src", "code.ts"), "export const value = 'Needle nested';", "utf8");
    await writeFile(join(worktreeRoot, "private", "secret.txt"), "needle hidden", "utf8");
    server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), token: "files-test-token",
      executionSurface: "desktop_managed", getSettingsForCwd, createAgent, logger: () => {},
    });
    await server.application.ready();
    const root = server.store.sessions.create({ cwd: projectRoot, model: "test-model",
      metadata: { runtime: { model: "test-model", approvalMode: "full_access" } },
    });
    const child = server.store.sessions.create({ parentId: root.id, cwd: worktreeRoot, model: "test-model",
      metadata: { runtime: { model: "test-model", approvalMode: "full_access" },
        desktop: { settingsRoot: projectRoot, worktree: { id: "test-worktree", path: worktreeRoot, branch: "test" } },
      },
    });
    rootSessionId = root.id;
    childSessionId = child.id;
    initialEventSequence = server.store.conversations.latestEventSeq();
    url = (await server.listen({ host: "127.0.0.1", port: 0 })).url;
    client = new VykorClient({ baseUrl: url, token: "files-test-token" });
  });

  afterAll(async () => {
    await server?.close();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads each persisted session directory while using the worktree owner's settings", async () => {
    expect((await client.protocol.capabilities()).features.sessionFiles).toBe(1);
    expect(await client.files.readText(rootSessionId, "note.txt")).toMatchObject({ content: "project only\nneedle project", truncated: false });
    expect(await client.files.readText(childSessionId, "note.txt")).toMatchObject({ content: "worktree only\nNEEDLE task", truncated: false });
    expect(await client.files.readText(childSessionId, "note.txt", { maxBytes: 4 })).toEqual({
      path: "note.txt", content: "work", encoding: "utf-8", truncated: true,
    });
    expect(getSettingsForCwd.mock.calls.length).toBeGreaterThan(0);
    for (const [settingsRoot] of getSettingsForCwd.mock.calls) expect(settingsRoot).toBe(projectRoot);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("lists, inspects, finds and searches only authorized workspace files", async () => {
    const listing = await client.files.list(childSessionId);
    expect(listing.path).toBe(".");
    expect(listing.entries.map(entry => entry.path)).toEqual(["src", "note.txt"]);
    expect(await client.files.stat(childSessionId, "note.txt")).toMatchObject({
      path: "note.txt", name: "note.txt", kind: "file", sizeBytes: 25, modifiedAt: expect.any(Number),
    });
    expect(await client.files.find(childSessionId, { pattern: "**/*.ts" })).toEqual({ path: ".", files: ["src/code.ts"], truncated: false });
    const search = await client.files.search(childSessionId, { query: "needle" });
    expect(search.matches).toEqual([
      { path: "note.txt", line: 2, text: "NEEDLE task" },
      { path: "src/code.ts", line: 1, text: "export const value = 'Needle nested';" },
    ]);
    expect(search.truncated).toBe(false);
    expect((await client.files.search(childSessionId, { query: "needle", include: "**/*.ts", caseSensitive: true })).matches).toEqual([]);
    expect((await client.files.search(childSessionId, { query: "Needle", include: "**/*.ts", caseSensitive: true })).matches).toHaveLength(1);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("returns stable errors for denied, missing and invalid query targets", async () => {
    await expect(client.files.readText(childSessionId, "private/secret.txt")).rejects.toMatchObject({ status: 403, body: { code: "file_forbidden" } });
    await expect(client.files.stat(childSessionId, "missing.txt")).rejects.toMatchObject({ status: 404, body: { code: "file_not_found" } });
    await expect(client.files.readText(childSessionId, "../project/note.txt")).rejects.toMatchObject({ status: 400, body: { code: "file_invalid_request" } });
    const unknown = await fetch(`${url}/sessions/${childSessionId}/files?cwd=${encodeURIComponent(projectRoot)}`, { headers });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "file_invalid_request" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("preserves protocol and bearer authorization and has no file mutation endpoint", async () => {
    const path = `/sessions/${childSessionId}/files`;
    const unversioned = await fetch(url + path);
    expect(unversioned.status).toBe(426);
    const unauthorized = await fetch(url + path, { headers: { [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) } });
    expect(unauthorized.status).toBe(401);
    const incompatible = await fetch(url + path, { headers: { ...headers, [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION + 1) } });
    expect(incompatible.status).toBe(426);
    const write = await fetch(`${url}${path}/text?path=note.txt`, { method: "POST", headers, body: "changed" });
    expect(write.status).toBe(404);
    expect(await readFile(join(worktreeRoot, "note.txt"), "utf8")).toBe("worktree only\nNEEDLE task");
    expect((await readdir(projectRoot)).sort()).toEqual(["note.txt"]);
    expect(server!.store.conversations.latestEventSeq()).toBe(initialEventSequence);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("returns 501 and omits the capability for a custom application without files", async () => {
    const application = Object.create(server!.application) as VykorHttpServer["application"];
    Object.defineProperty(application, "files", { value: undefined });
    const custom = new VykorHttpServer({ application, logger: () => {} });
    try {
      const capabilities = await custom.app.request("/capabilities");
      expect((await capabilities.json()).features).not.toHaveProperty("sessionFiles");
      const response = await custom.app.request(`/sessions/${childSessionId}/files`, { headers });
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "file_not_supported" });
    } finally { await custom.close(); }
  });
});
